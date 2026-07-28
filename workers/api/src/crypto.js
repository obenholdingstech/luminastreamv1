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
