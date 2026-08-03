// Run: node --test workers/api/test/crypto.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlEncode,
  base64UrlDecode,
  base64UrlEncodeJson,
  decodeJson,
  sha256,
  hmacSha256,
  timingSafeEqual,
  constantTimeCompareSecrets,
  seal,
  unseal,
} from '../src/crypto.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('base64url output is URL-safe (no +, /, or = padding)', () => {
  // FB FF BF is "+/+/" in standard base64 — the worst case for URL-safety.
  const enc = base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]));
  assert.equal(enc, '-_-_');
  assert.ok(!/[+/=]/.test(enc));
});

test('base64url round-trips arbitrary byte lengths', () => {
  for (let n = 0; n <= 40; n += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(base64UrlDecode(base64UrlEncode(bytes)), bytes);
  }
});

test('json encode/decode round-trip', () => {
  const obj = { a: 1, b: 'two', c: [3, 4], d: { e: true } };
  assert.deepEqual(decodeJson(base64UrlDecode(base64UrlEncodeJson(obj))), obj);
});

test('sha256 matches the known NIST vector for "abc"', async () => {
  assert.equal(
    hex(await sha256('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('hmacSha256 matches a known HMAC-SHA256 vector', async () => {
  // HMAC-SHA256(key="key", "The quick brown fox jumps over the lazy dog")
  assert.equal(
    hex(await hmacSha256('key', 'The quick brown fox jumps over the lazy dog')),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
});

test('timingSafeEqual: equal→true, differ→false, length-mismatch→false', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([]), new Uint8Array([])), true);
});

test('constantTimeCompareSecrets: same→true, different→false (incl. differing lengths)', async () => {
  assert.equal(await constantTimeCompareSecrets('hunter2', 'hunter2'), true);
  assert.equal(await constantTimeCompareSecrets('hunter2', 'hunter3'), false);
  // hashing both sides equalizes length, so a length difference is still safe
  assert.equal(await constantTimeCompareSecrets('short', 'a-much-longer-password'), false);
});

test('constantTimeCompareSecrets: non-strings are rejected', async () => {
  assert.equal(await constantTimeCompareSecrets(undefined, 'x'), false);
  assert.equal(await constantTimeCompareSecrets('x', null), false);
  assert.equal(await constantTimeCompareSecrets(123, 123), false);
});

test('seal/unseal: roundtrip under the same secret+purpose, fresh IV per seal', async () => {
  const a = await seal('secret', 'video-vendor-token', 'rt_client_abc123');
  const b = await seal('secret', 'video-vendor-token', 'rt_client_abc123');
  assert.notEqual(a, b, 'a repeated seal must not produce a recognizable ciphertext');
  assert.equal(await unseal('secret', 'video-vendor-token', a), 'rt_client_abc123');
  assert.equal(await unseal('secret', 'video-vendor-token', b), 'rt_client_abc123');
  assert.ok(!a.includes('rt_client_abc123'), 'the plaintext never appears in the sealed form');
});

test('unseal: wrong secret, wrong purpose, tampering, and garbage all yield null', async () => {
  const sealed = await seal('secret', 'video-vendor-token', 'rt_client_abc123');
  assert.equal(await unseal('other-secret', 'video-vendor-token', sealed), null);
  assert.equal(
    await unseal('secret', 'some-other-purpose', sealed),
    null,
    'the purpose label partitions the keyspace — a seal for one job opens nothing else',
  );
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(await unseal('secret', 'video-vendor-token', tampered), null, 'GCM authenticates');
  assert.equal(await unseal('secret', 'video-vendor-token', 'not-base64!!'), null);
});
