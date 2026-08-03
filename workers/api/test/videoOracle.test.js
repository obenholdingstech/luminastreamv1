// Run: node --test workers/api/test/videoOracle.test.js
//
// ─── THE VIDEO O(1) ORACLE ─────────────────────────────────────────────────
//
// The SpendLedger must obey the same invariant the SessionRegistry proved
// (ROADMAP §P1, applied to §P2): Durable Object requests per video session
// are a CONSTANT, never a function of how long the video ran. A meter that
// ticked per second would keep the ledger awake for the whole stream — the
// measured cost bug, rebuilt with money attached.
//
//   | Clean:     reserve → settle          | ≤ 2 requests, 0 alarms  |
//   | Abandoned: reserve → reaped          | ≤ 1 request,  1 alarm   |
//   | Short vs long video                  | counts IDENTICAL        |
//   | N concurrent reservations            | ≤ N × budget            |
//
// Counted through the REAL HTTP surface, because the requests the product
// spends are the ones the Worker makes.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { SpendLedger, SETTLE_SLACK_SECONDS } from '../src/spendLedger.js';
import { createRegistryHarness } from '../testkit/registryHarness.js';

const ADMIN_PASSWORD = 'correct horse battery staple';
const STUDIO = 'https://studio.luminastream.live';
const MINUTE = 60_000;

const allowLimiter = { async limit() { return { success: true }; } };
const denyLimiter = { async limit() { return { success: false }; } };

function setup({ perSession = 180, total = 3000 } = {}) {
  const env = {
    ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    VERIFY_LIMITER: allowLimiter,
    VIDEO_LIMITER: allowLimiter,
    VIDEO_ENABLED: 'true',
    MAX_VIDEO_SECONDS_PER_SESSION: String(perSession),
    MAX_VIDEO_SECONDS_TOTAL: String(total),
  };
  const h = createRegistryHarness({ env, startAt: Date.now(), cls: SpendLedger });
  env.VIDEO_LEDGER = h.namespace;
  return { env, h };
}

function req(path, { method = 'GET', origin, token, body, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.luminastream.live${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function adminToken(env) {
  const res = await worker.fetch(
    req('/api/admin/verify', { method: 'POST', body: { password: ADMIN_PASSWORD } }),
    env,
  );
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

const reserveHttp = (env, token, body) =>
  worker.fetch(req('/api/video/reserve', { method: 'POST', origin: STUDIO, token, body }), env);
const settleHttp = (env, token, body) =>
  worker.fetch(req('/api/video/settle', { method: 'POST', origin: STUDIO, token, body }), env);
const budgetHttp = (env, token) =>
  worker.fetch(req('/api/video/budget', { origin: STUDIO, token }), env);

// ─── the oracle rows ───────────────────────────────────────────────────────

test('ORACLE clean video session: reserve → settle costs ≤ 2 requests and 0 alarms', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();

  const r = await (await reserveHttp(env, token, { requestedSeconds: 120 })).json();
  assert.equal(r.ok, true);
  const s = await (
    await settleHttp(env, token, {
      reservationId: r.reservationId,
      settleToken: r.settleToken,
      usedSeconds: 90,
    })
  ).json();
  assert.equal(s.settled, true);

  const { requests, alarms } = h.counts();
  assert.ok(requests <= 2, `clean video session spent ${requests} DO requests, budget is 2`);
  assert.equal(alarms, 0);
});

test('ORACLE abandoned reservation: reserve → reaped costs ≤ 1 request and exactly 1 alarm', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();

  await reserveHttp(env, token, { requestedSeconds: 60 });
  await h.advanceBy((60 + SETTLE_SLACK_SECONDS + 1) * 1000);

  const { requests, alarms } = h.counts();
  assert.ok(requests <= 1, `abandoned reservation spent ${requests} DO requests, budget is 1`);
  assert.equal(alarms, 1);
  assert.equal(h.pendingAlarm(), null);
});

test('ORACLE short vs long video: a 10-second and a full-cap stream cost exactly the same', async () => {
  async function runVideo(usedSeconds, holdMs) {
    const { env, h } = setup();
    const token = await adminToken(env);
    h.resetCounts();
    const r = await (await reserveHttp(env, token)).json();
    await h.advanceBy(holdMs);
    const s = await (
      await settleHttp(env, token, {
        reservationId: r.reservationId,
        settleToken: r.settleToken,
        usedSeconds,
      })
    ).json();
    assert.equal(s.settled, true);
    return h.counts();
  }

  const short = await runVideo(10, 10_000);
  const long = await runVideo(180, 180_000);
  assert.deepEqual(long, short, 'ledger cost must not track video duration');
  assert.equal(short.requests, 2);
  assert.equal(short.alarms, 0);
});

test('ORACLE N concurrent reservations cost ≤ N × the single budget', async () => {
  const N = 5;
  const { env, h } = setup({ perSession: 60, total: 600 });
  const token = await adminToken(env);
  h.resetCounts();

  const held = [];
  for (let i = 0; i < N; i += 1) {
    held.push(await (await reserveHttp(env, token, { requestedSeconds: 60 })).json());
  }
  for (const r of held) {
    await settleHttp(env, token, {
      reservationId: r.reservationId,
      settleToken: r.settleToken,
      usedSeconds: 60,
    });
  }
  const { requests, alarms } = h.counts();
  assert.ok(requests <= N * 2, `${N} sessions spent ${requests}, budget ${N * 2}`);
  assert.equal(alarms, 0);
});

// ─── the wall through HTTP ─────────────────────────────────────────────────

test('the exhausted wall refuses through the API with the honest code', async () => {
  const { env } = setup({ perSession: 100, total: 100 });
  const token = await adminToken(env);
  assert.equal((await reserveHttp(env, token)).status, 200);
  const res = await reserveHttp(env, token);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'video_budget_exhausted');
});

test('budget reads carry the private cache header, like capacity', async () => {
  const { env } = setup();
  const token = await adminToken(env);
  const res = await budgetHttp(env, token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') ?? '', /\bprivate\b/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), STUDIO);
});

test('video routes require a valid admin session and the right method', async () => {
  const { env } = setup();
  assert.equal((await reserveHttp(env, undefined)).status, 401);
  assert.equal((await worker.fetch(req('/api/video/reserve', { token: 'x' }), env)).status, 405);
  assert.equal(
    (await worker.fetch(req('/api/video/budget', { method: 'POST', token: 'x' }), env)).status,
    405,
  );
  assert.equal((await worker.fetch(req('/api/video/nope', { method: 'POST' }), env)).status, 404);
});

test('a MISSING video limiter or ledger binding refuses, loudly', async () => {
  const { env } = setup();
  const token = await adminToken(env);

  const noLimiter = await reserveHttp({ ...env, VIDEO_LIMITER: undefined }, token);
  assert.equal(noLimiter.status, 503);
  assert.equal((await noLimiter.json()).error, 'rate_limiter_unavailable');

  const noLedger = await reserveHttp({ ...env, VIDEO_LEDGER: undefined }, token);
  assert.equal(noLedger.status, 503);
  assert.equal(
    (await noLedger.json()).error,
    'video_ledger_unavailable',
    'a dropped binding must refuse video, never serve it unmetered',
  );
});

test('the video limiter throttles BEFORE the admin check', async () => {
  const { env } = setup();
  const res = await worker.fetch(
    req('/api/video/reserve', { method: 'POST', token: 'garbage.token' }),
    { ...env, VIDEO_LIMITER: denyLimiter },
  );
  assert.equal(res.status, 429);
});

test('a malformed settle body never reaches the ledger', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();
  const res = await settleHttp(env, token, { reservationId: '' });
  assert.equal(res.status, 400);
  assert.equal(h.counts().requests, 0, 'a malformed settle must not spend a DO request');
});

test('a misconfigured ledger surfaces as 500 without echoing the config', async () => {
  const { env } = setup();
  env.MAX_VIDEO_SECONDS_TOTAL = 'all of it';
  const token = await adminToken(env);
  const res = await reserveHttp(env, token);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'server_misconfigured');
  assert.equal(body.detail, undefined, 'the offending value belongs in the log, not the response');
});

test('reset through the API zeroes the meter (dev-card re-arm)', async () => {
  const { env, h } = setup({ perSession: 100, total: 100 });
  const token = await adminToken(env);
  await reserveHttp(env, token);
  assert.equal((await reserveHttp(env, token)).status, 503);

  const reset = await worker.fetch(
    req('/api/video/reset', { method: 'POST', origin: STUDIO, token }),
    env,
  );
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).released, 1);
  // Alarm checked BEFORE the follow-up reserve, which correctly arms a new
  // one. (The registry reset test made this exact mistake once; the lesson
  // holds across objects.)
  assert.equal(h.pendingAlarm(), null);
  assert.equal((await reserveHttp(env, token)).status, 200, 'usable immediately');
});
