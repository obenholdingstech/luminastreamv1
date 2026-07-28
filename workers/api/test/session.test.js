// Run: node --test workers/api/test/session.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, SESSION_TTL_SECONDS } from '../src/session.js';
import { base64UrlEncode, base64UrlEncodeJson, hmacSha256 } from '../src/crypto.js';

const SECRET = 'unit-test-session-secret';

test('12h ttl: sign→verify valid, subject admin, exp = now + 12h', async () => {
  const now = 1_700_000_000;
  const { token, expiresAt } = await signSession(SECRET, { now });
  assert.equal(expiresAt, now + SESSION_TTL_SECONDS);
  assert.equal(SESSION_TTL_SECONDS, 12 * 60 * 60);

  const res = await verifySession(SECRET, token, { now: now + 60 });
  assert.equal(res.valid, true);
  assert.equal(res.payload.sub, 'admin');
  assert.equal(res.payload.exp, now + SESSION_TTL_SECONDS);
});

test('expired token → { valid:false, reason:"expired" }', async () => {
  const now = 1_700_000_000;
  const { token } = await signSession(SECRET, { now, ttlSeconds: 100 });
  const res = await verifySession(SECRET, token, { now: now + 101 });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'expired');
});

test('wrong secret → bad-signature', async () => {
  const { token } = await signSession(SECRET);
  const res = await verifySession('a-different-secret', token);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'bad-signature');
});

test('tampered payload (forged longer expiry) → bad-signature', async () => {
  const now = 1_700_000_000;
  const { token } = await signSession(SECRET, { now });
  const originalSig = token.split('.')[1];
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: 'admin', iat: now, exp: now + 999_999 }),
  ).toString('base64url');
  const res = await verifySession(SECRET, `${forgedPayload}.${originalSig}`, { now: now + 60 });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'bad-signature');
});

test('well-signed but non-admin subject → bad-subject (proves the subject check)', async () => {
  const now = 1_700_000_000;
  const payloadB64 = base64UrlEncodeJson({ sub: 'root', iat: now, exp: now + 1000 });
  const sig = base64UrlEncode(await hmacSha256(SECRET, payloadB64));
  const res = await verifySession(SECRET, `${payloadB64}.${sig}`, { now });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'bad-subject');
});

test('malformed tokens are rejected without throwing', async () => {
  for (const bad of ['', 'nodotshere', 'a.b.c', '.', 'x.', '.y', 'not base64!.also!']) {
    const res = await verifySession(SECRET, bad);
    assert.equal(res.valid, false);
  }
  assert.equal((await verifySession(SECRET, undefined)).reason, 'missing');
});

test('missing secret → no-secret', async () => {
  const { token } = await signSession(SECRET);
  assert.equal((await verifySession('', token)).reason, 'no-secret');
});
