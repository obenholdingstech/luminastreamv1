// Run: node --test workers/api/test/sessionOracle.test.js
//
// ─── THE O(1) ORACLE ───────────────────────────────────────────────────────
//
// ROADMAP.md §P1 states the invariant this file enforces:
//
//   "DO requests per session must be a constant, independent of how long the
//    session lasts. Never O(session duration)."
//
// "Constant" is not a test, so the roadmap also specifies the budget, and this
// is it. Every fetch() into the Durable Object stub and every alarm()
// invocation is counted, through the REAL HTTP surface — because the requests
// the product actually spends are the ones the Worker makes, not the ones a
// unit test makes on its behalf.
//
//   | Clean:    create → capacity → end   | ≤ 3 requests, 0 alarms          |
//   | Abandoned: create → reaped          | ≤ 2 requests, exactly 1 alarm   |
//   | Short vs long session               | counts IDENTICAL                |
//   | N concurrent sessions               | ≤ N × budget                    |
//
// The rows do different jobs. The first two bound the constant. The third is
// the duration-scaling detector, and it is the one that survives a poll being
// added WITHIN the per-case budget: a request that fires twice in a short
// session and two hundred times in a long one keeps every per-case count
// plausible while breaking the invariant outright. Only comparing a short
// session against a long one convicts that.
//
// Discrimination-tested — the mutations and their results are recorded in
// devlog/SESSIONS.md for this session.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { createRegistryHarness } from '../testkit/registryHarness.js';

const ADMIN_PASSWORD = 'correct horse battery staple';
const STUDIO = 'https://studio.luminastream.live';
const LEASE_SECONDS = 7200; // 2h, matching wrangler.jsonc
const MINUTE = 60_000;

const allowLimiter = { async limit() { return { success: true }; } };
const denyLimiter = { async limit() { return { success: false }; } };

// The harness clock starts at the real one so the Worker's own Date.now() —
// used only to size the LiveKit grant — agrees with it at the outset.
function setup({ capacity = 1, lease = LEASE_SECONDS, startAt = Date.now() } = {}) {
  const env = {
    ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    LIVEKIT_API_KEY: 'APIkey',
    LIVEKIT_API_SECRET: 'secretsecretsecret',
    LIVEKIT_URL: 'wss://proj.livekit.cloud',
    VERIFY_LIMITER: allowLimiter,
    TOKEN_LIMITER: allowLimiter,
    SESSION_LIMITER: allowLimiter,
    MAX_CONCURRENT_SESSIONS: String(capacity),
    SESSION_LEASE_SECONDS: String(lease),
  };
  // The registry reads its config from the same env object the Worker does,
  // exactly as it will in production.
  const h = createRegistryHarness({ env, startAt });
  env.SESSION_REGISTRY = h.namespace;
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

// The three session calls, as the product makes them.
const createSession = (env, token) =>
  worker.fetch(req('/api/session/create', { method: 'POST', origin: STUDIO, token }), env);
const readCapacity = (env, token) =>
  worker.fetch(req('/api/session/capacity', { origin: STUDIO, token }), env);
const endSession = (env, token, body) =>
  worker.fetch(req('/api/session/end', { method: 'POST', origin: STUDIO, token, body }), env);

// ─── row 1: the clean session ──────────────────────────────────────────────

test('ORACLE clean session: create → capacity → end costs ≤ 3 requests and 0 alarms', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();

  const created = await (await createSession(env, token)).json();
  assert.equal(created.ok, true);
  await readCapacity(env, token);
  const ended = await (
    await endSession(env, token, { sessionId: created.sessionId, endToken: created.endToken })
  ).json();
  assert.equal(ended.ended, true);

  const { requests, alarms } = h.counts();
  assert.ok(requests <= 3, `clean session spent ${requests} DO requests, budget is 3`);
  assert.equal(alarms, 0, 'a session that ends cleanly must never wake the reaper');
});

// ─── row 2: the abandoned session ──────────────────────────────────────────

test('ORACLE abandoned session: create → reaped costs ≤ 2 requests and exactly 1 alarm', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();

  const created = await (await createSession(env, token)).json();
  assert.equal(created.ok, true);

  // Nobody calls end. The tab was closed, the laptop slept, the network died.
  await h.advanceBy((LEASE_SECONDS + 1) * 1000);

  const { requests, alarms } = h.counts();
  assert.ok(requests <= 2, `abandoned session spent ${requests} DO requests, budget is 2`);
  assert.equal(alarms, 1, 'exactly one wakeup reclaims the slot');
  assert.equal(h.pendingAlarm(), null, 'and it does not leave another one armed');

  // And the slot really is free afterwards.
  const capacity = await (await readCapacity(env, token)).json();
  assert.equal(capacity.live, 0);
  assert.equal(capacity.available, 1);
});

test('ORACLE abandonment costs the same whether it is noticed in a minute or a week', async () => {
  const quick = setup();
  const slow = setup();
  const [tq, ts] = [await adminToken(quick.env), await adminToken(slow.env)];
  quick.h.resetCounts();
  slow.h.resetCounts();

  await createSession(quick.env, tq);
  await createSession(slow.env, ts);

  await quick.h.advanceBy((LEASE_SECONDS + 60) * 1000); // just past the lease
  await slow.h.advanceBy(7 * 24 * 60 * MINUTE); // a week later

  assert.deepEqual(
    slow.h.counts(),
    quick.h.counts(),
    'an abandoned slot must cost one wakeup, not one per interval',
  );
});

test('ORACLE many abandoned sessions sharing an expiry cost ONE alarm between them', async () => {
  // The single-session row asserts "exactly 1", which is the tightest case and
  // not the general rule. One wakeup reaps everything that has expired, so the
  // real bound is the number of DISTINCT pending expiries — never the number of
  // sessions, and never the elapsed time. Worth a test rather than a sentence:
  // it is the claim the prose in sessionRegistry.js and ROADMAP.md now makes,
  // and it is stronger than "one alarm each", so it is the one that would be
  // quietly lost if #rearm ever armed per session.
  const N = 5;
  const { env, h } = setup({ capacity: N });
  const token = await adminToken(env);
  h.resetCounts();

  for (let i = 0; i < N; i += 1) {
    assert.equal((await (await createSession(env, token)).json()).ok, true);
  }
  // All created at the same instant on the harness clock, so all five leases
  // fall due together.
  await h.advanceBy((LEASE_SECONDS + 1) * 1000);

  const { requests, alarms } = h.counts();
  assert.equal(requests, N, 'one create each, nothing more');
  assert.equal(alarms, 1, `${N} sessions expiring together must cost ONE wakeup, not ${N}`);
  assert.equal(h.pendingAlarm(), null);
  assert.equal((await (await readCapacity(env, token)).json()).available, N, 'all reclaimed');
});

// ─── row 3: THE DURATION-SCALING DETECTOR ──────────────────────────────────

test('ORACLE short vs long: a 30-second and a full-lease session cost exactly the same', async () => {
  async function runSession(holdMs) {
    const { env, h } = setup();
    const token = await adminToken(env);
    h.resetCounts();

    const created = await (await createSession(env, token)).json();
    assert.equal(created.ok, true);
    await h.advanceBy(holdMs);
    await readCapacity(env, token);
    await h.advanceBy(holdMs);
    const ended = await (
      await endSession(env, token, { sessionId: created.sessionId, endToken: created.endToken })
    ).json();
    assert.equal(ended.ended, true, 'the session must survive its own duration');
    return h.counts();
  }

  const short = await runSession(15_000); // 30 seconds end to end
  // Right up to the lease boundary — one second short of expiry, so this is
  // the longest session the product can have, not merely a long one. Anything
  // less would leave the claim "a full-lease session costs the same" untested
  // at exactly the point it is most likely to stop being true.
  const long = await runSession((LEASE_SECONDS * 1000 - 1000) / 2);

  // Two assertions doing two different jobs, and it is worth being exact about
  // which catches what. The comparison is the DURATION detector: it is the only
  // thing that fails when cost tracks elapsed time. The absolute pins BOUND the
  // constant: a uniform extra request would raise both sides equally and slip
  // past the comparison untouched.
  assert.deepEqual(
    long,
    short,
    'cost must not track duration — this is the assertion a duration-scaling poll cannot survive',
  );
  assert.equal(short.requests, 3);
  assert.equal(short.alarms, 0);
});

test('the lease is the ceiling on "long", and it is documented rather than infinite', async () => {
  // Honesty about the shape of the guarantee. A session cannot outlive its
  // lease, because it cannot outlive the LiveKit grant minted for the same
  // span. So the claim is not "duration is free forever" — it is "no request
  // is made as a function of elapsed time WITHIN a lease", and the lease is
  // hours, not seconds. Supporting longer sessions means renewal, which is
  // O(duration / 2h) — bounded, and emphatically not O(seconds).
  const { env, h } = setup();
  const token = await adminToken(env);
  const created = await (await createSession(env, token)).json();

  await h.advanceBy((LEASE_SECONDS + 1) * 1000);
  const ended = await (
    await endSession(env, token, { sessionId: created.sessionId, endToken: created.endToken })
  ).json();
  assert.equal(ended.ok, true);
  assert.equal(ended.ended, false, 'past its lease the slot was already reclaimed');
});

// ─── row 4: concurrency ────────────────────────────────────────────────────

test('ORACLE N concurrent sessions cost ≤ N × the single-session budget', async () => {
  const N = 4;
  const { env, h } = setup({ capacity: N });
  const token = await adminToken(env);
  h.resetCounts();

  const sessions = [];
  for (let i = 0; i < N; i += 1) {
    const created = await (await createSession(env, token)).json();
    assert.equal(created.ok, true, `session ${i + 1} of ${N} should be admitted`);
    sessions.push(created);
  }
  for (const s of sessions) await readCapacity(env, token);
  for (const s of sessions) {
    await endSession(env, token, { sessionId: s.sessionId, endToken: s.endToken });
  }

  const { requests, alarms } = h.counts();
  assert.ok(requests <= N * 3, `${N} sessions spent ${requests} requests, budget is ${N * 3}`);
  assert.equal(alarms, 0);
  assert.equal(h.pendingAlarm(), null, 'all four ended cleanly, so no alarm survives them');
});

// ─── why no poll is needed in the first place ──────────────────────────────

test('create returns everything the client needs, so it never has to ask again', async () => {
  // Rule 1 is only affordable because of this: the browser is told its room
  // ONCE. If any of these fields were missing the client would have to come
  // back for it, and coming back on a schedule is the poll the invariant
  // forbids. Everything after this travels over the LiveKit data channel.
  const { env } = setup();
  const token = await adminToken(env);
  const created = await (await createSession(env, token)).json();

  for (const field of ['sessionId', 'endToken', 'room', 'identity', 'token', 'url', 'expiresAt']) {
    assert.ok(created[field], `create must return ${field}`);
  }
  assert.equal(created.token.split('.').length, 3, 'a real LiveKit JWT, minted server-side');
  assert.equal(created.url, 'wss://proj.livekit.cloud');
  // Epoch SECONDS, matching /api/livekit/token. The registry keeps
  // milliseconds internally; the Worker is the only place the units meet.
  assert.ok(created.expiresAt > 1_000_000_000 && created.expiresAt < 100_000_000_000);
});

test('the grant expires with the slot, never after it', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const created = await (await createSession(env, token)).json();

  const record = [...h.stored().values()][0];
  assert.equal(
    created.expiresAt,
    Math.floor(record.expiresAt / 1000),
    'a token outliving its slot would let a stranger join a reallocated room',
  );
});

test('the capacity read carries a cache header — the one route that invites polling', async () => {
  const { env } = setup();
  const token = await adminToken(env);
  const res = await readCapacity(env, token);
  assert.equal(res.status, 200);
  const cacheControl = res.headers.get('Cache-Control') ?? '';
  assert.match(cacheControl, /max-age=5/);
  // `private` matters: the route is authenticated by X-Admin-Token, which is
  // not in Vary, so a shared cache would be entitled to key on the URL alone
  // and serve one caller's capacity view to another.
  assert.match(cacheControl, /\bprivate\b/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), STUDIO, 'CORS survives the header merge');
});

// ─── HTTP behaviour: gates, refusals, fail-closed ──────────────────────────

test('capacity is enforced through the API: the second session gets 503 at_capacity', async () => {
  const { env } = setup({ capacity: 1 });
  const token = await adminToken(env);
  assert.equal((await createSession(env, token)).status, 200);

  const res = await createSession(env, token);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'at_capacity');
  assert.equal(body.capacity, 1);
});

test('a released slot is immediately reusable', async () => {
  const { env } = setup({ capacity: 1 });
  const token = await adminToken(env);
  const first = await (await createSession(env, token)).json();
  await endSession(env, token, { sessionId: first.sessionId, endToken: first.endToken });
  assert.equal((await createSession(env, token)).status, 200);
});

test('session routes require a valid admin session', async () => {
  const { env } = setup();
  assert.equal((await createSession(env, undefined)).status, 401);
  assert.equal((await readCapacity(env, 'garbage.token')).status, 401);
  assert.equal((await endSession(env, undefined, { sessionId: 'a', endToken: 'b' })).status, 401);
});

test('session routes reject the wrong method', async () => {
  const { env } = setup();
  const token = await adminToken(env);
  assert.equal((await worker.fetch(req('/api/session/create', { token }), env)).status, 405);
  assert.equal(
    (await worker.fetch(req('/api/session/capacity', { method: 'POST', token }), env)).status,
    405,
  );
});

test('ending someone else’s session is refused with 403 and frees nothing', async () => {
  const { env } = setup();
  const token = await adminToken(env);
  const created = await (await createSession(env, token)).json();

  const res = await endSession(env, token, { sessionId: created.sessionId, endToken: 'guessed' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'end_refused');
  assert.equal((await (await readCapacity(env, token)).json()).live, 1);
});

test('end without a session id or token → 400, and never reaches the registry', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();
  assert.equal((await endSession(env, token, {})).status, 400);
  assert.equal(h.counts().requests, 0, 'a malformed release must not spend a DO request');
});

test('the session limiter throttles BEFORE the admin check', async () => {
  const { env } = setup();
  const throttled = { ...env, SESSION_LIMITER: denyLimiter };
  const res = await worker.fetch(
    req('/api/session/create', { method: 'POST', token: 'garbage.token' }),
    throttled,
  );
  assert.equal(res.status, 429, 'anonymous flooding must be stopped by the cheap check');
});

test('a MISSING session limiter refuses the request rather than passing it through', async () => {
  const { env, h } = setup();
  const token = await adminToken(env);
  h.resetCounts();
  const res = await createSession({ ...env, SESSION_LIMITER: undefined }, token);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'rate_limiter_unavailable');
  assert.equal(h.counts().requests, 0);
});

// ─── fail closed when the Durable Object itself is not there ───────────────

test('a MISSING durable object binding refuses sessions, loudly', async () => {
  // A deploy that drops the `durable_objects` block from wrangler.jsonc must
  // not hand out unbounded rooms with nothing counting them. Same posture as
  // the rate limiter: a guard that disappears in silence is the worst shape a
  // bug can take.
  const { env } = setup();
  const token = await adminToken(env);
  for (const binding of [undefined, {}, { get: () => {} }]) {
    const res = await createSession({ ...env, SESSION_REGISTRY: binding }, token);
    assert.equal(res.status, 503, `binding ${JSON.stringify(binding)} must refuse`);
    assert.equal((await res.json()).error, 'session_registry_unavailable');
  }
});

test('a THROWING durable object stub is unavailable, not permission', async () => {
  const { env } = setup();
  const token = await adminToken(env);
  const exploding = {
    idFromName: (n) => n,
    get() {
      return { async fetch() { throw new Error('DO unreachable'); } };
    },
  };
  const res = await createSession({ ...env, SESSION_REGISTRY: exploding }, token);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'session_registry_unavailable');
});

test('a misconfigured registry surfaces as 500 without echoing the config back', async () => {
  const { env } = setup();
  env.MAX_CONCURRENT_SESSIONS = 'as many as we can';
  const token = await adminToken(env);
  const res = await createSession(env, token);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'server_misconfigured');
  assert.equal(body.detail, undefined, 'the offending value belongs in the log, not the response');
});

test('a failed LiveKit mint gives the slot back instead of leaking capacity', async () => {
  const { env, h } = setup({ capacity: 1 });
  const token = await adminToken(env);
  const broken = { ...env, LIVEKIT_API_SECRET: undefined };

  const res = await createSession(broken, token);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'mint_failed');

  // The slot must be free — otherwise one vendor hiccup holds capacity for the
  // whole lease.
  assert.equal((await (await readCapacity(env, token)).json()).available, 1);
  assert.equal(h.pendingAlarm(), null, 'and the released slot takes its alarm with it');
});
