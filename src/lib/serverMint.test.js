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

// ── deadlines ──────────────────────────────────────────────────────────────
// fetch() has no timeout of its own, so a hung request would leave the unlock
// form disabled forever with nothing to show. These pin the deadline down.

test('every request carries an abort signal', async () => {
  const signals = [];
  stub(async (_url, opts) => {
    signals.push(opts.signal);
    return jsonResponse(200, { ok: true, token: 'sess.tok' });
  });
  await verifyAdmin('pw', BASE);
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal, 'verifyAdmin sent no signal');
});

// A request that only ever settles on abort. If the deadline is not wired
// through, this rejects on its own guard timer rather than hanging: a test that
// hangs is barely better than one that cannot fail, because it stalls the suite
// instead of naming the defect. Verified by deleting the signal from postJson —
// these fail with 'no deadline reached fetch' instead of blocking.
function hangsUntilAborted(guardMs = 2000) {
  return (_url, opts) =>
    new Promise((_resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error('no deadline reached fetch')),
        guardMs,
      );
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(guard);
        reject(opts.signal.reason);
      });
    });
}

test('a hung request becomes a readable error, not an endless wait', async () => {
  stub(hangsUntilAborted());
  await assert.rejects(
    () => verifyAdmin('pw', BASE, AbortSignal.timeout(10)),
    /did not respond/,
    'a timed-out verify must surface as a human-readable error',
  );
  await assert.rejects(
    () => mintToken('sess', { room: 'r', identity: 'i' }, BASE, AbortSignal.timeout(10)),
    /did not respond/,
    'a timed-out mint must surface as a human-readable error',
  );
});

test('mintViaServer shares ONE deadline across every hop', async () => {
  const signals = [];
  let call = 0;
  stub(async (_url, opts) => {
    signals.push(opts.signal);
    call += 1;
    if (call === 1) return jsonResponse(200, { ok: true, token: 'sess.tok' }); // verify
    if (call === 2) return jsonResponse(401, { ok: false }); // mint → session expired
    if (call === 3) return jsonResponse(200, { ok: true, token: 'sess2.tok' }); // re-verify
    return jsonResponse(200, { ok: true, token: 'lk.tok', url: 'wss://x' }); // mint
  });

  const out = await mintViaServer({ password: 'pw', room: 'r', identity: 'i' }, BASE);
  assert.equal(out.token, 'lk.tok');
  assert.equal(signals.length, 4, 'the retry path should make four requests');
  // One deadline for the exchange, not one per hop — otherwise the worst case
  // stacks to four times the budget.
  assert.equal(new Set(signals).size, 1, 'each hop got its own deadline');
});

test('a caller may shorten the deadline', async () => {
  stub(hangsUntilAborted());
  const started = Date.now();
  await assert.rejects(
    () => mintViaServer({ password: 'pw', room: 'r', identity: 'i', timeoutMs: 20 }, BASE),
    /did not respond/,
  );
  assert.ok(Date.now() - started < 5000, 'the short deadline was ignored');
});

test('a runtime without AbortSignal.timeout still gets a real deadline', async () => {
  // The fallback matters most on exactly the older runtimes that would
  // otherwise be handed the one code path with no deadline at all.
  const realTimeout = AbortSignal.timeout;
  // eslint-disable-next-line no-undef
  Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
  try {
    stub(hangsUntilAborted());
    await assert.rejects(
      () => mintViaServer({ password: 'pw', room: 'r', identity: 'i', timeoutMs: 20 }, BASE),
      /did not respond/,
      'the AbortController fallback did not fire',
    );
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', {
      value: realTimeout,
      configurable: true,
    });
  }
});
