// Run: node --test — the Worker keyring: the pool behind ELEVENLABS_API_KEY.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anyVendorKey,
  fingerprintKey,
  isPaymentRefusal,
  parsePool,
} from '../src/vendorKeys.js';

test('a bare single key is a pool of one — full back-compat', async () => {
  const pool = await parsePool('sk_only');
  assert.equal(pool.length, 1);
  assert.equal(pool[0].key, 'sk_only');
  assert.match(pool[0].fingerprint, /^k[0-9a-f]{8}$/);
});

test('order is preference; whitespace, blanks and dupes drop', async () => {
  const pool = await parsePool('  sk_b , sk_a ,sk_b,, ');
  assert.deepEqual(pool.map((c) => c.key), ['sk_b', 'sk_a']);
});

test('fingerprints are stable, distinct, and never the key', async () => {
  const [a1, a2, b] = [
    await fingerprintKey('sk_alpha'),
    await fingerprintKey('sk_alpha'),
    await fingerprintKey('sk_beta'),
  ];
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.ok(!a1.includes('sk_'));
});

test('anyVendorKey: a pool claim — commas alone are not a pool', () => {
  assert.equal(anyVendorKey({ ELEVENLABS_API_KEY: 'sk_x' }), true);
  assert.equal(anyVendorKey({ ELEVENLABS_API_KEY: 'sk_a,sk_b' }), true);
  assert.equal(anyVendorKey({ ELEVENLABS_API_KEY: '' }), false);
  assert.equal(anyVendorKey({ ELEVENLABS_API_KEY: ' , ' }), false);
  assert.equal(anyVendorKey({}), false);
});

test('isPaymentRefusal: money only — deterministic rejections must not double-spend', () => {
  assert.equal(isPaymentRefusal(401, { detail: { status: 'payment_required' } }), true);
  assert.equal(isPaymentRefusal(402, { detail: { status: 'quota_exceeded' } }), true);
  assert.equal(isPaymentRefusal(401, { detail: 'invalid_api_key' }), false, 'bad key ≠ money');
  assert.equal(isPaymentRefusal(400, { detail: { status: 'payment_required' } }), false, 'a 400 is a sample problem');
  assert.equal(isPaymentRefusal(429, 'slow down'), false);
  assert.equal(isPaymentRefusal(500, 'oops'), false);
});
