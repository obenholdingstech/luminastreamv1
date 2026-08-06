// P4b — the auth core: password KDF, session tokens, cookies, validation.
// Pure functions over Web Crypto (identical in Workers and Node 20+), every
// security decision written down where it is made:
//
// * Passwords: PBKDF2-SHA384 via crypto.subtle, 100k iterations, 16-byte
//   salt, stored in a VERSIONED format — strengthening the KDF later is a
//   rehash-on-next-signin, never a password reset. (Argon2/scrypt are not in
//   Workers' native crypto; PBKDF2 at this cost is the strongest primitive
//   that runs native here, and native is what keeps it inside CPU limits.)
// * Policy: length over composition (NIST 800-63B) — 10..200 chars, no
//   forced character classes, no truncation.
// * Session tokens: 256 random bits, base64url. The DATABASE stores only
//   SHA-256(token); the browser holds the token in an HttpOnly cookie the
//   page's JavaScript can never read.
// * Timing: verification compares with timingSafeEqual, and callers get
//   DUMMY_PASSWORD_HASH to verify against when the account does not exist —
//   "no such user" and "wrong password" must cost the same time and return
//   the same words.

import { base64UrlDecode, base64UrlEncode, sha256, timingSafeEqual } from './crypto.js';

const encoder = new TextEncoder();

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_SECONDS = 14 * 24 * 3600;
// last_seen updates are throttled to this — activity is a coarse fact, and a
// write per request would make the busiest table the most expensive one.
export const LAST_SEEN_THROTTLE_SECONDS = 3600;

export const SESSION_COOKIE = '__Secure-lumina-session';

const KDF_SCHEME = 'pbkdf2-sha384';

/** Lowercased, trimmed — the canonical form `auth_identities.subject` stores. */
export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** Deliberately permissive (RFC-lite): shape + bounds. The real proof of an
 * email is a verification message (arrives with email infra), not a regex. */
export function isPlausibleEmail(email) {
  return (
    typeof email === 'string' &&
    email.length >= 3 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

/** null when acceptable; a MACHINE token otherwise (the UI owns the prose). */
export function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'password_required';
  if (password.length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'password_too_long';
  return null;
}

async function deriveBits(password, salt, iterations, subtle) {
  const key = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-384', salt, iterations },
    key,
    384,
  );
  return new Uint8Array(bits);
}

/**
 * → `pbkdf2-sha384$v1$<iterations>$<salt>$<hash>` (base64url fields).
 * @param {string} password
 */
export async function hashPassword(
  password,
  { iterations = PBKDF2_ITERATIONS, subtle = crypto.subtle, getRandomValues = (a) => crypto.getRandomValues(a) } = {},
) {
  const salt = getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, iterations, subtle);
  return `${KDF_SCHEME}$v1$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

/**
 * Constant-time verification against the stored format.
 * @returns {Promise<{ ok: boolean, needsRehash: boolean }>} needsRehash when
 * the stored cost is below the current standard — the caller rehashes on a
 * successful sign-in, which is how the fleet strengthens without a reset.
 */
export async function verifyPassword(password, stored, { subtle = crypto.subtle } = {}) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 5 || parts[0] !== KDF_SCHEME || parts[1] !== 'v1') {
    return { ok: false, needsRehash: false };
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return { ok: false, needsRehash: false };
  let salt;
  let expected;
  try {
    salt = base64UrlDecode(parts[3]);
    expected = base64UrlDecode(parts[4]);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const actual = await deriveBits(password, salt, iterations, subtle);
  return {
    ok: timingSafeEqual(actual, expected),
    needsRehash: iterations < PBKDF2_ITERATIONS,
  };
}

// A real hash of an unknowable password ("…" salted at build of this file is
// wrong — it must be produced by the SAME code path). Generated lazily once:
// the not-found sign-in path verifies against it so "no such user" costs the
// same KDF time as "wrong password".
let dummyHashPromise = null;
export function dummyPasswordHash(deps) {
  dummyHashPromise ??= hashPassword(crypto.randomUUID(), deps);
  return dummyHashPromise;
}

/** 256 random bits, base64url — the value the cookie carries. */
export function newSessionToken({ getRandomValues = (a) => crypto.getRandomValues(a) } = {}) {
  return base64UrlEncode(getRandomValues(new Uint8Array(32)));
}

/** What the DATABASE stores. The raw token never touches a row. */
export async function sessionTokenHash(token) {
  return base64UrlEncode(await sha256(token));
}

/**
 * The Set-Cookie value for a fresh session. HttpOnly (no script access),
 * Secure (the __Secure- prefix REQUIRES it), SameSite=None because the
 * studio and the API are different origins today — the api.luminastream.live
 * custom domain (CEO DNS action) makes them same-site, which is what Safari
 * needs; the attribute is correct under both.
 */
export function sessionCookie(token, { maxAge = SESSION_TTL_SECONDS } = {}) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=None`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`;
}

/** The session token out of a Cookie header, or null. */
export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
