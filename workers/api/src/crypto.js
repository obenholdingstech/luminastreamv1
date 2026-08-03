// Web Crypto helpers — pure standard APIs (crypto.subtle, TextEncoder, atob/
// btoa) that behave identically in the Cloudflare Workers runtime and in
// Node 20+. No dependencies, so the whole signing/comparison surface is
// auditable in a public repo.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// base64url (RFC 4648 §5, no padding) of raw bytes.
export function base64UrlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeJson(obj) {
  return base64UrlEncode(encoder.encode(JSON.stringify(obj)));
}

// base64url → Uint8Array. Throws on malformed input (invalid base64).
export function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function decodeJson(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

export async function sha256(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// Raw HMAC-SHA256 bytes of `message` under UTF-8 `secret`.
export async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// Constant-time byte comparison. Runs over the longer of the two so a length
// mismatch never short-circuits, and folds the length difference into the
// accumulator so unequal lengths can never compare equal.
export function timingSafeEqual(a, b) {
  const ua = a instanceof Uint8Array ? a : new Uint8Array(a);
  const ub = b instanceof Uint8Array ? b : new Uint8Array(b);
  const len = Math.max(ua.length, ub.length);
  let diff = ua.length ^ ub.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (ua[i] ?? 0) ^ (ub[i] ?? 0);
  }
  return diff === 0;
}

// AES-256-GCM sealing for a secret that must RIDE THROUGH the browser
// without ever being readable by it (the video control token carries the
// vendor's session-scoped client token this way — Decart accepts session
// control only from the token that created the session, and the white-label
// canon forbids handing that token to the browser in usable form). The key is
// derived from the secret + a purpose label, so the seal can never be
// confused with a signature made from the same secret.
async function aesKeyFromSecret(secret, purpose) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:${purpose}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// → base64url(iv ‖ ciphertext‖tag). A fresh random IV per seal.
export async function seal(secret, purpose, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKeyFromSecret(secret, purpose);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return base64UrlEncode(packed);
}

// Returns the plaintext, or null for anything malformed or tampered — GCM
// authenticates, so a flipped bit is a null, never garbage output.
export async function unseal(secret, purpose, sealed) {
  try {
    const packed = base64UrlDecode(sealed);
    const key = await aesKeyFromSecret(secret, purpose);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) },
      key,
      packed.slice(12),
    );
    return decoder.decode(pt);
  } catch {
    return null;
  }
}

// Constant-time secret comparison per the LiveKit/admin spec: SHA-256 BOTH
// sides via Web Crypto and compare the fixed-length digests — never `===` on
// the raw strings (which leaks length and prefix via early exit). Hashing
// first also equalizes length so the compare is constant-time regardless of
// how long the attacker's guess is.
export async function constantTimeCompareSecrets(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return timingSafeEqual(ha, hb);
}
