// Run: node --test — the auth core, unit level (Node 20+ shares Web Crypto
// with the Workers runtime, so the KDF here IS the KDF in production).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PBKDF2_ITERATIONS,
  SESSION_COOKIE,
  clearSessionCookie,
  hashPassword,
  isPlausibleEmail,
  newSessionToken,
  normalizeEmail,
  passwordPolicyError,
  readSessionCookie,
  sessionCookie,
  sessionTokenHash,
  verifyPassword,
} from '../src/auth.js';

test('hash → verify roundtrip; a wrong password fails; the format is versioned', async () => {
  const stored = await hashPassword('correct horse battery staple', { iterations: 1000 });
  assert.match(stored, /^pbkdf2-sha384\$v1\$1000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal((await verifyPassword('correct horse battery staple', stored)).ok, true);
  assert.equal((await verifyPassword('wrong horse', stored)).ok, false);
});

test('two hashes of the same password differ — the salt is doing its job', async () => {
  const a = await hashPassword('same password here', { iterations: 1000 });
  const b = await hashPassword('same password here', { iterations: 1000 });
  assert.notEqual(a, b);
});

test('a below-standard iteration count verifies but demands a rehash', async () => {
  const stored = await hashPassword('correct horse battery staple', { iterations: 1000 });
  const verdict = await verifyPassword('correct horse battery staple', stored);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.needsRehash, true, `1000 < ${PBKDF2_ITERATIONS} ⇒ strengthen on sign-in`);
});

test('malformed stored hashes fail closed — never throw, never verify', async () => {
  for (const bad of ['', 'plaintext', 'pbkdf2-sha384$v1$abc$!!$!!', 'md5$v1$1$x$y', null, undefined]) {
    const verdict = await verifyPassword('anything', bad);
    assert.equal(verdict.ok, false, `must refuse: ${String(bad).slice(0, 20)}`);
  }
});

test('password policy: length over composition, both bounds enforced', () => {
  assert.equal(passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH)), null);
  assert.equal(passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH - 1)), 'password_too_short');
  assert.equal(passwordPolicyError('a'.repeat(PASSWORD_MAX_LENGTH + 1)), 'password_too_long');
  assert.equal(passwordPolicyError(12345), 'password_required');
  assert.equal(passwordPolicyError(undefined), 'password_required');
});

test('email normalization is the canonical stored form; plausibility is shape + bounds', () => {
  assert.equal(normalizeEmail('  CEO@Example.COM '), 'ceo@example.com');
  assert.equal(isPlausibleEmail('ceo@example.com'), true);
  assert.equal(isPlausibleEmail('not-an-email'), false);
  assert.equal(isPlausibleEmail('a@b'), false, 'needs a dot after the @ host');
  assert.equal(isPlausibleEmail('x'.repeat(250) + '@a.co'), false, 'RFC length cap');
});

test('session tokens: 256 bits, base64url; the stored value is the HASH, never the token', async () => {
  const token = newSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const hash = await sessionTokenHash(token);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hash, token);
  assert.notEqual(newSessionToken(), token, 'tokens are unique');
});

test('the cookie is HttpOnly + Secure + SameSite; parse and clear roundtrip', () => {
  const cookie = sessionCookie('tok123');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Path=\//);
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=tok123; other=1`), 'tok123');
  assert.equal(readSessionCookie(`other=1; ${SESSION_COOKIE}=tok123`), 'tok123');
  assert.equal(readSessionCookie('other=1'), null);
  assert.equal(readSessionCookie(''), null);
  assert.equal(readSessionCookie(undefined), null);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});
