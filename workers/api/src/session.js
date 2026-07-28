// Admin session token — a compact HMAC-signed bearer the client sends back as
// `X-Admin-Token` after passing the admin gate. Not a LiveKit token and not a
// JWT (no header segment); just `base64url(payload).base64url(HMAC(payload))`
// signed with ADMIN_SESSION_SECRET. Short-lived (~12h) and stateless — no
// server-side session store, so nothing to revoke and nothing to leak.

import {
  base64UrlEncode,
  base64UrlEncodeJson,
  base64UrlDecode,
  decodeJson,
  hmacSha256,
  timingSafeEqual,
} from './crypto.js';

export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
const SUBJECT = 'admin';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function signSession(secret, { now = nowSeconds(), ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  const payload = { sub: SUBJECT, iat: now, exp: now + ttlSeconds };
  const payloadB64 = base64UrlEncodeJson(payload);
  const sig = await hmacSha256(secret, payloadB64);
  return { token: `${payloadB64}.${base64UrlEncode(sig)}`, expiresAt: payload.exp };
}

export async function verifySession(secret, token, { now = nowSeconds() } = {}) {
  if (!secret) return { valid: false, reason: 'no-secret' };
  if (typeof token !== 'string' || token.length === 0) return { valid: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;

  let provided;
  try {
    provided = base64UrlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // Verify the signature BEFORE trusting anything in the payload.
  const expected = await hmacSha256(secret, payloadB64);
  if (!timingSafeEqual(expected, provided)) return { valid: false, reason: 'bad-signature' };

  let payload;
  try {
    payload = decodeJson(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.sub !== SUBJECT) return { valid: false, reason: 'bad-subject' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}
