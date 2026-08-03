// Run: node --test src/lib/videoClient.test.js
//
// What matters here is not "does it POST" but the promises the topology makes
// to a person: the browser never carries vendor credentials, a refusal says
// something true and actionable, and "stop" never claims more than happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVideoSession,
  sendCandidates,
  setVideoPrompt,
  endVideoSession,
  readVideoBudget,
  isDurationLimitError,
} from './videoClient.js';

const BASE = 'https://api.example';
const original = globalThis.fetch;
const stub = (h) => (globalThis.fetch = h);
test.afterEach(() => (globalThis.fetch = original));

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const GRANT = {
  ok: true,
  sessionId: 'sess-1',
  controlToken: 'ctrl.tok',
  grantedSeconds: 60,
  remainingSeconds: 2940,
  vendor: { sdpAnswer: 'v=0 answer', iceServers: [], eventToken: 'sse-tok' },
};

test('create sends the offer and returns the server-chosen session + control token', async () => {
  stub(async (url, opts) => {
    assert.equal(url, `${BASE}/api/video/session`);
    assert.equal(opts.headers['X-Admin-Token'], 'admin.tok');
    assert.equal(JSON.parse(opts.body).sdpOffer, 'v=0 offer');
    return json(200, GRANT);
  });
  const s = await createVideoSession('admin.tok', { sdpOffer: 'v=0 offer' }, BASE);
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(s.controlToken, 'ctrl.tok');
  assert.equal(s.vendor.sdpAnswer, 'v=0 answer');
  assert.equal(s.vendor.eventToken, 'sse-tok', "the vendor's browser-safe token passes through");
});

test('an exhausted video budget says so plainly, and carries its code', async () => {
  stub(async () => json(503, { ok: false, error: 'video_budget_exhausted' }));
  await assert.rejects(() => createVideoSession('t', { sdpOffer: 'o' }, BASE), (err) => {
    assert.match(err.message, /budget is spent/);
    assert.equal(err.code, 'video_budget_exhausted');
    return true;
  });
});

test('every named refusal gets prose, never the raw code', async () => {
  // The sessionClient lesson, applied before it could be learned twice.
  for (const code of [
    'video_budget_exhausted',
    'video_disabled',
    'video_vendor_unconfigured',
    'at_capacity',
    'some_future_code',
  ]) {
    stub(async () => json(503, { ok: false, error: code }));
    // assert.rejects, NOT a bare .catch: assertions inside a catch that never
    // runs are assertions that never execute — the test would pass with zero
    // checks if the refusal ever stopped rejecting.
    await assert.rejects(
      () => createVideoSession('t', { sdpOffer: 'o' }, BASE),
      (err) => {
        assert.ok(!err.message.includes(code), `${code} leaked into the message`);
        assert.match(err.message, /[a-z]{3,} [a-z]{2,}/i, `${code} does not read as English`);
        assert.equal(err.code, code, 'the code stays available to callers');
        return true;
      },
    );
  }
});

test('a 200 without a control token is a refusal, not a session', async () => {
  stub(async () => json(200, { ok: true, sessionId: 'x' }));
  await assert.rejects(() => createVideoSession('t', { sdpOffer: 'o' }, BASE));
});

test('create refuses without an SDP offer, before touching the network', async () => {
  let called = 0;
  stub(async () => {
    called += 1;
    return json(200, GRANT);
  });
  await assert.rejects(() => createVideoSession('t', {}, BASE), /SDP offer/);
  assert.equal(called, 0);
});

test('candidates and prompts never throw — a lost candidate is not a teardown', async () => {
  stub(async () => {
    throw new Error('network');
  });
  assert.equal(await sendCandidates('t', { sessionId: 's', controlToken: 'c' }, [], BASE), false);
  assert.equal(await setVideoPrompt('t', { sessionId: 's', controlToken: 'c' }, 'p', BASE), false);
});

test('candidates carry the control token and the ETag', async () => {
  let body = null;
  stub(async (url, opts) => {
    body = JSON.parse(opts.body);
    assert.match(String(url), /\/api\/video\/session\/s1\/candidates$/);
    return json(200, { ok: true });
  });
  await sendCandidates('t', { sessionId: 's1', controlToken: 'c1', etag: 'e1' }, [{ candidate: 'x' }], BASE);
  assert.equal(body.controlToken, 'c1');
  assert.equal(body.etag, 'e1');
});

test('end reports what actually happened — settled, or DEFERRED', async () => {
  stub(async () => json(200, { ok: true, settled: true, usedSeconds: 42 }));
  assert.deepEqual(await endVideoSession('t', { sessionId: 's', controlToken: 'c' }, BASE), {
    ok: true,
    settled: true,
    usedSeconds: 42,
  });

  // The vendor delete failed; the server kept the reservation for its
  // executioner. The UI must say "closing", not "closed" — the one case where
  // stop is not instantly true, and claiming otherwise is the silent freeze.
  stub(async () => json(502, { ok: false, error: 'vendor_delete_failed' }));
  const deferred = await endVideoSession('t', { sessionId: 's', controlToken: 'c' }, BASE);
  assert.equal(deferred.ok, false);
  assert.equal(deferred.deferred, true);
});

test('end never throws, even when the network is gone', async () => {
  stub(async () => {
    throw new Error('down');
  });
  assert.deepEqual(await endVideoSession('t', { sessionId: 's', controlToken: 'c' }, BASE), { ok: false });
});

test('the budget read returns null rather than throwing', async () => {
  stub(async () => json(200, { ok: true, remainingSeconds: 100 }));
  assert.equal((await readVideoBudget('t', BASE)).remainingSeconds, 100);
  stub(async () => json(503, { ok: false }));
  assert.equal(await readVideoBudget('t', BASE), null);
});

test('the duration-limit error is recognised — the probe-measured terminal signal', () => {
  // Measured 3 Aug: the vendor stops generating and says this, then the SDK
  // auto-reconnects into a not-generating zombie. Recognising the string is
  // what makes the reconnect ignorable instead of a silent freeze.
  assert.equal(isDurationLimitError(new Error('Session duration limit reached')), true);
  assert.equal(isDurationLimitError('session duration limit reached'), true);
  assert.equal(isDurationLimitError(new Error('ICE failed')), false);
  assert.equal(isDurationLimitError(null), false);
  assert.equal(isDurationLimitError(undefined), false);
});
