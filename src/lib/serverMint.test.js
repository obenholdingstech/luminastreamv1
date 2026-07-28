// Run: node --test src/lib/serverMint.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAdmin, mintToken, mintViaServer } from './serverMint.js';

const BASE = 'https://api.example';
const original = globalThis.fetch;

function stub(handler) {
  globalThis.fetch = handler;
}
test.afterEach(() => {
  globalThis.fetch = original;
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('verifyAdmin posts the password and returns the session token', async () => {
  stub(async (url, opts) => {
    assert.equal(url, `${BASE}/api/admin/verify`);
    assert.equal(opts.method, 'POST');
    assert.equal(JSON.parse(opts.body).password, 'pw');
    return jsonResponse(200, { ok: true, token: 'sess.tok' });
  });
  assert.equal(await verifyAdmin('pw', BASE), 'sess.tok');
});

test('verifyAdmin maps 401/429 to friendly errors', async () => {
  stub(async () => jsonResponse(401, { ok: false, error: 'invalid_password' }));
  await assert.rejects(() => verifyAdmin('pw', BASE), /wrong admin password/);

  stub(async () => jsonResponse(429, { ok: false, error: 'rate_limited' }));
  await assert.rejects(() => verifyAdmin('pw', BASE), /too many attempts/);
});

test('verifyAdmin without a base throws (VITE_API_BASE unset)', async () => {
  await assert.rejects(() => verifyAdmin('pw', ''), /not configured/);
});

test('mintToken sends X-Admin-Token and returns token + url', async () => {
  stub(async (url, opts) => {
    assert.equal(url, `${BASE}/api/livekit/token`);
    assert.equal(opts.headers['X-Admin-Token'], 'sess.tok');
    assert.deepEqual(JSON.parse(opts.body), { room: 'r', identity: 'u' });
    return jsonResponse(200, { ok: true, token: 'lk.jwt.sig', url: 'wss://p.livekit.cloud' });
  });
  assert.deepEqual(await mintToken('sess.tok', { room: 'r', identity: 'u' }, BASE), {
    token: 'lk.jwt.sig',
    url: 'wss://p.livekit.cloud',
  });
});

test('mintToken surfaces a 401 with .status for retry logic', async () => {
  stub(async () => jsonResponse(401, { ok: false, error: 'unauthorized' }));
  await assert.rejects(
    () => mintToken('stale', { room: 'r', identity: 'u' }, BASE),
    (err) => err.status === 401 && /session expired/.test(err.message),
  );
});

test('mintViaServer verifies first when no session, then mints', async () => {
  const calls = [];
  stub(async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    assert.equal(opts.headers['X-Admin-Token'], 'fresh');
    return jsonResponse(200, { ok: true, token: 'lk', url: 'wss://p' });
  });
  const out = await mintViaServer({ password: 'pw', room: 'r', identity: 'u' }, BASE);
  assert.deepEqual(out, { token: 'lk', url: 'wss://p', adminToken: 'fresh' });
  assert.deepEqual(calls, [`${BASE}/api/admin/verify`, `${BASE}/api/livekit/token`]);
});

test('mintViaServer re-authenticates once on an expired session', async () => {
  let mintCalls = 0;
  stub(async (url) => {
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 're-auth' });
    mintCalls += 1;
    if (mintCalls === 1) return jsonResponse(401, { ok: false, error: 'unauthorized' });
    return jsonResponse(200, { ok: true, token: 'lk2', url: 'wss://p2' });
  });
  // start with a stale session token; password present so retry can re-auth
  const out = await mintViaServer(
    { password: 'pw', adminToken: 'stale', room: 'r', identity: 'u' },
    BASE,
  );
  assert.equal(out.token, 'lk2');
  assert.equal(out.adminToken, 're-auth');
});

test('mintViaServer does not retry a 401 when no password is available', async () => {
  stub(async (url) => {
    if (url.endsWith('/api/livekit/token')) return jsonResponse(401, { ok: false });
    throw new Error('should not call verify without a password');
  });
  await assert.rejects(
    () => mintViaServer({ adminToken: 'stale', room: 'r', identity: 'u' }, BASE),
    /session expired/,
  );
});
