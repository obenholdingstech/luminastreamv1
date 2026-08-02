// Run: node --test workers/api/test/sessionRegistry.test.js
//
// The Durable Object's own behaviour, driven directly. The cost invariant is
// tested separately and through the HTTP surface (sessionOracle.test.js) —
// this file is about whether the registry is CORRECT: does it hold capacity,
// does it refuse a stranger's release, does it clean up after itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SessionRegistry,
  readRegistryConfig,
  RegistryConfigError,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  DEFAULT_SESSION_ROOMS,
} from '../src/sessionRegistry.js';
import { MAX_LIVEKIT_TTL_SECONDS } from '../src/livekit.js';
import { createRegistryHarness, registryRequest } from '../testkit/registryHarness.js';

const T0 = Date.UTC(2026, 7, 2, 12, 0, 0);
const LEASE = 7200;
const POOL = ['room-a', 'room-b'];
const ENV = {
  SESSION_ROOMS: POOL.join(','),
  MAX_CONCURRENT_SESSIONS: '2',
  SESSION_LEASE_SECONDS: String(LEASE),
};

function harness(env = ENV) {
  return createRegistryHarness({ env, startAt: T0 });
}

async function call(h, path, body) {
  const res = await h.instance.fetch(registryRequest(path, body));
  return { status: res.status, body: await res.json() };
}

const create = (h) => call(h, '/create');
const capacity = (h) => call(h, '/capacity');
const end = (h, sessionId, endToken) => call(h, '/end', { sessionId, endToken });

// ─── allocation ────────────────────────────────────────────────────────────

test('create allocates a room FROM THE POOL, an identity, and the configured lease', async () => {
  const h = harness();
  const { status, body } = await create(h);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(
    POOL.includes(body.session.room),
    `room ${body.session.room} must come from the pool, not be invented — an invented ` +
      'room has no agent in it, so the browser would wait forever for a reply',
  );
  assert.match(body.session.identity, /^speaker-[0-9a-f]{8}$/);
  assert.equal(body.session.createdAt, T0);
  assert.equal(body.session.expiresAt, T0 + LEASE * 1000);
  assert.equal(body.leaseSeconds, LEASE);
  assert.equal(body.live, 1);
  assert.equal(body.capacity, 2);
  assert.equal(typeof body.endToken, 'string');
  assert.ok(body.endToken.length >= 40, 'the release token must not be guessable');
});

test('two creates get different pool rooms and different identities', async () => {
  const h = harness();
  const a = (await create(h)).body;
  const b = (await create(h)).body;
  assert.notEqual(
    a.session.room,
    b.session.room,
    'two sessions in one room means LiveKit evicts the first speaker mid-sentence',
  );
  assert.deepEqual([a.session.room, b.session.room].sort(), [...POOL].sort());
  assert.notEqual(a.session.identity, b.session.identity);
  assert.notEqual(a.endToken, b.endToken);
});

test('a released room goes back to the pool and is handed out again', async () => {
  const h = harness();
  const first = (await create(h)).body;
  const second = (await create(h)).body;
  assert.equal((await create(h)).status, 503, 'pool exhausted');

  await end(h, first.session.id, first.endToken);
  const third = (await create(h)).body;
  assert.equal(third.session.room, first.session.room, 'the freed room is reused');
  assert.notEqual(third.session.room, second.session.room, 'the held one is not');
});

test('a room reclaimed by the reaper is handed out again', async () => {
  const h = harness();
  const first = (await create(h)).body;
  await create(h);
  await h.advanceBy((LEASE + 1) * 1000);

  const fresh = (await create(h)).body;
  assert.ok(POOL.includes(fresh.session.room));
  assert.notEqual(
    fresh.session.identity,
    first.session.identity,
    'a reused room must not reuse the identity — that is the eviction case',
  );
});

test('capacity is min(pool size, MAX_CONCURRENT_SESSIONS) — the pool can never be exceeded', async () => {
  // The policy cap can never admit MORE sessions than there are agents. It may
  // equal that number — min permits equality, and production runs at exactly
  // that today — it just cannot exceed it.
  const policyBound = harness({ SESSION_ROOMS: 'a,b,c,d', MAX_CONCURRENT_SESSIONS: '2' });
  assert.equal((await capacity(policyBound)).body.capacity, 2);
  assert.equal((await capacity(policyBound)).body.pool, 4);

  const poolBound = harness({ SESSION_ROOMS: 'a,b', MAX_CONCURRENT_SESSIONS: '99' });
  assert.equal(
    (await capacity(poolBound)).body.capacity,
    2,
    'a policy cap above the pool must NOT admit sessions onto rooms with no agent',
  );
  assert.equal((await capacity(poolBound)).body.pool, 2);
});

test('a pool bound below the policy cap refuses the extra session at the pool limit', async () => {
  const h = harness({ SESSION_ROOMS: 'only-room', MAX_CONCURRENT_SESSIONS: '50' });
  assert.equal((await create(h)).status, 200);
  const refused = await create(h);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'at_capacity');
  assert.equal(refused.body.capacity, 1);
  assert.equal(refused.body.pool, 1);
});

test('the release token is never stored in the clear', async () => {
  const h = harness();
  const { endToken } = (await create(h)).body;
  const dump = JSON.stringify([...h.stored().values()]);
  assert.ok(!dump.includes(endToken), 'a storage dump must not hand over live sessions');
  assert.ok(dump.includes('endTokenHash'));
});

test('capacity reports enabled / live / capacity / available / pool', async () => {
  const h = harness();
  const base = { ok: true, enabled: true, capacity: 2, pool: POOL.length };
  assert.deepEqual((await capacity(h)).body, { ...base, live: 0, available: 2 });
  await create(h);
  assert.deepEqual((await capacity(h)).body, { ...base, live: 1, available: 1 });
  await create(h);
  assert.deepEqual((await capacity(h)).body, { ...base, live: 2, available: 0 });
});

test('the session past capacity is refused with 503 at_capacity, not silently admitted', async () => {
  const h = harness();
  await create(h);
  await create(h);
  const { status, body } = await create(h);
  assert.equal(status, 503);
  assert.equal(body.error, 'at_capacity');
  assert.equal(body.live, 2);
  assert.equal(body.capacity, 2);
});

// ─── release ───────────────────────────────────────────────────────────────

test('end with the right token frees the slot', async () => {
  const h = harness();
  const { session, endToken } = (await create(h)).body;
  const { status, body } = await end(h, session.id, endToken);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, ended: true, live: 0 });
  assert.equal((await capacity(h)).body.live, 0);
});

test('end with the WRONG token is refused and the slot stays held', async () => {
  const h = harness();
  const { session } = (await create(h)).body;
  const { status, body } = await end(h, session.id, 'not-the-token');
  assert.equal(status, 403);
  assert.equal(body.error, 'end_refused');
  assert.equal(
    (await capacity(h)).body.live,
    1,
    'a wrong token must never free someone else’s session',
  );
});

test('end of an already-ended session succeeds — release calls get retried', async () => {
  const h = harness();
  const { session, endToken } = (await create(h)).body;
  await end(h, session.id, endToken);
  const { status, body } = await end(h, session.id, endToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ended, false);
  assert.equal(body.reason, 'unknown_session');
});

test('end without a session id or token → 400', async () => {
  const h = harness();
  assert.equal((await call(h, '/end', {})).status, 400);
  assert.equal((await call(h, '/end', { sessionId: 'x' })).status, 400);
  assert.equal((await call(h, '/end', { endToken: 'y' })).status, 400);
});

test('an unknown registry path → 404', async () => {
  const h = harness();
  assert.equal((await call(h, '/nope')).status, 404);
});

// ─── expiry: the lease, not the alarm, is what defines "live" ──────────────

test('an expired session stops counting toward capacity even before the alarm fires', async () => {
  const h = harness();
  await create(h);
  // Move the clock WITHOUT letting the alarm run. Alarm delivery can be
  // delayed, so an ordinary request can land on an object whose leases ran out
  // while nothing swept — and it must not report a dead session as live just
  // because the reaper has not been by yet.
  h.warpBy((LEASE + 1) * 1000);
  assert.equal((await capacity(h)).body.live, 0);
});

test('a malformed stored record is swept rather than holding a slot forever', async () => {
  const h = harness();
  await h.storage.put('session:corrupt', { id: 'corrupt' }); // no expiresAt
  assert.equal((await capacity(h)).body.live, 0);
  assert.equal(h.stored().size, 0, 'the unparseable record must be cleaned up, not counted');
});

test('more than 128 leases expiring at once are all swept', async () => {
  // storage.delete() takes at most 128 keys per call and THROWS above that, so
  // an unchunked sweep would strand the whole reap — on the one occasion it
  // matters most, a busy registry where every lease ran out together and the
  // reaper is the only thing that can clear them. The harness enforces the real
  // limit, so removing the chunking in #liveSessions turns this red.
  const rooms = Array.from({ length: 300 }, (_, i) => `room-${i}`);
  const h = harness({
    SESSION_ROOMS: rooms.join(','),
    MAX_CONCURRENT_SESSIONS: '300',
    SESSION_LEASE_SECONDS: String(LEASE),
  });
  for (let i = 0; i < 300; i += 1) await create(h);
  assert.equal((await capacity(h)).body.live, 300);

  await h.advanceBy((LEASE + 1) * 1000);
  assert.equal(h.stored().size, 0, 'every expired record must be deleted, not the first 128');
  assert.equal((await capacity(h)).body.available, 300);
});

// ─── the alarm: one, at the earliest expiry ────────────────────────────────

test('create arms exactly one alarm, at the session expiry', async () => {
  const h = harness();
  const { session } = (await create(h)).body;
  assert.equal(h.pendingAlarm(), session.expiresAt);
});

test('the alarm tracks the EARLIEST pending expiry, and moves to the next one after a reap', async () => {
  const h = harness();
  const first = (await create(h)).body.session;
  await h.advanceBy(60_000); // a minute later — no alarm is due yet
  const second = (await create(h)).body.session;

  assert.ok(second.expiresAt > first.expiresAt);
  assert.equal(h.pendingAlarm(), first.expiresAt, 'earliest expiry wins');

  await h.advanceTo(first.expiresAt);
  assert.equal(h.counts().alarms, 1);
  assert.equal(h.pendingAlarm(), second.expiresAt, 're-armed to the next one, not to a fixed sweep');
  assert.equal(h.stored().size, 1);

  await h.advanceTo(second.expiresAt);
  assert.equal(h.counts().alarms, 2);
  assert.equal(h.pendingAlarm(), null, 'the last session leaving takes the alarm with it');
  assert.equal(h.stored().size, 0);
});

test('ending the only session cancels the alarm — a clean session never wakes the reaper', async () => {
  const h = harness();
  const { session, endToken } = (await create(h)).body;
  assert.equal(h.pendingAlarm(), session.expiresAt);
  await end(h, session.id, endToken);
  assert.equal(h.pendingAlarm(), null);

  await h.advanceBy(LEASE * 2 * 1000);
  assert.equal(h.counts().alarms, 0);
});

test('the reaper never re-arms into the past (no self-triggering loop)', async () => {
  // The harness throws after 100 chained alarms; this is the assertion that
  // the guard exists to make. A #rearm that could schedule at or before `now`
  // would spin the object awake indefinitely — the most expensive bug this
  // file could contain, since a permanently awake object bills 128 MB of wall
  // clock and never hibernates.
  const h = harness();
  await create(h);
  await h.advanceBy(LEASE * 10 * 1000);
  assert.equal(h.counts().alarms, 1);
  assert.equal(h.pendingAlarm(), null);
});

// ─── configuration: malformed is fatal, never a silent default ─────────────

test('defaults apply when nothing is configured', () => {
  const config = readRegistryConfig({});
  assert.equal(config.capacity, DEFAULT_MAX_CONCURRENT_SESSIONS);
  assert.equal(config.leaseSeconds, DEFAULT_LEASE_SECONDS);
});

test('a malformed count is FATAL, not a quiet fallback', () => {
  for (const bad of ['two', '1.5', '-1', 'l', '1e3', ' ', '0x10']) {
    assert.throws(
      () => readRegistryConfig({ MAX_CONCURRENT_SESSIONS: bad }),
      RegistryConfigError,
      `MAX_CONCURRENT_SESSIONS=${JSON.stringify(bad)} must not resolve to a default`,
    );
  }
  assert.throws(() => readRegistryConfig({ MAX_CONCURRENT_SESSIONS: '0' }), RegistryConfigError);
});

test('a room listed TWICE in the pool is FATAL', () => {
  // The most dangerous malformed pool there is: it would hand one room to two
  // sessions, and LiveKit evicts on duplicate identity — so the second speaker
  // silently kicks the first out of a call they are mid-sentence in. It reads
  // as a flaky connection, never as a configuration error.
  assert.throws(
    () => readRegistryConfig({ SESSION_ROOMS: 'a,b,a' }),
    RegistryConfigError,
    'a duplicated room must never resolve to a working pool',
  );
  assert.throws(() => readRegistryConfig({ SESSION_ROOMS: 'a, a' }), RegistryConfigError);
});

test('an empty pool entry — a stray comma — is FATAL', () => {
  for (const bad of ['a,,b', 'a,', ',a', 'a, ,b']) {
    assert.throws(
      () => readRegistryConfig({ SESSION_ROOMS: bad }),
      RegistryConfigError,
      `SESSION_ROOMS=${JSON.stringify(bad)} must not silently drop the empty entry`,
    );
  }
});

test('the pool defaults to the room the agent actually joins', () => {
  const config = readRegistryConfig({});
  assert.deepEqual(config.rooms, [DEFAULT_SESSION_ROOMS]);
  assert.equal(config.capacity, 1);
});

test('an unset or blank SESSION_ROOMS falls back rather than producing an empty pool', () => {
  // An empty pool would mean capacity 0 — the registry would refuse every
  // session with at_capacity and look exactly like an outage.
  for (const blank of [undefined, null, '', '   ']) {
    const config = readRegistryConfig({ SESSION_ROOMS: blank });
    assert.deepEqual(config.rooms, [DEFAULT_SESSION_ROOMS]);
    assert.ok(config.capacity >= 1);
  }
});

test('THE POOL DEFAULT MATCHES THE AGENT — parsed from convert_agent.py', () => {
  // The coupling that this whole change exists to enforce. If someone renames
  // the agent's default room, the registry would hand out a room with no agent
  // in it — the browser connects, publishes its microphone, and waits forever
  // while the registry reports a healthy session. Exactly the bug the room pool
  // replaced, reintroduced by a rename.
  const agentSrc = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'agent', 'convert_agent.py'),
    'utf8',
  );
  const match = agentSrc.match(/^DEFAULT_ROOM\s*=\s*["']([^"']+)["']/m);
  assert.ok(match, 'convert_agent.py must declare DEFAULT_ROOM — parse this test if it moved');
  assert.equal(
    DEFAULT_SESSION_ROOMS,
    match[1],
    `the registry's default pool (${DEFAULT_SESSION_ROOMS}) must be the room the agent ` +
      `joins (${match[1]}) — otherwise sessions are handed a room nobody serves`,
  );
});

test('sessions are enabled by default, and refusable with one variable', async () => {
  assert.equal(readRegistryConfig({}).enabled, true);

  const off = harness({ ...ENV, SESSIONS_ENABLED: 'false' });
  const { status, body } = await create(off);
  assert.equal(status, 503);
  assert.equal(
    body.error,
    'sessions_disabled',
    '"no agents here" must be distinguishable from "agents are busy" — a client ' +
      'that cannot tell them apart retries the permanent one forever',
  );

  const view = (await capacity(off)).body;
  assert.equal(view.enabled, false);
  assert.equal(view.capacity, 0, 'no agents means no capacity, whatever the pool lists');
  assert.equal(view.available, 0);
});

test('a malformed SESSIONS_ENABLED is FATAL, in both directions', () => {
  // Read as falsy it would silently take sessions offline; read as truthy it
  // would silently promise agents that do not exist. Neither quietly.
  for (const bad of ['flase', 'yes', 'no', '1', '0', 'TRUE ish']) {
    assert.throws(
      () => readRegistryConfig({ SESSIONS_ENABLED: bad }),
      RegistryConfigError,
      `SESSIONS_ENABLED=${JSON.stringify(bad)} must not resolve silently`,
    );
  }
  assert.equal(readRegistryConfig({ SESSIONS_ENABLED: 'TRUE' }).enabled, true);
  assert.equal(readRegistryConfig({ SESSIONS_ENABLED: ' False ' }).enabled, false);
});

test('a lease outside the allowed band is FATAL', () => {
  assert.throws(
    () => readRegistryConfig({ SESSION_LEASE_SECONDS: String(MIN_LEASE_SECONDS - 1) }),
    RegistryConfigError,
  );
  assert.throws(
    () => readRegistryConfig({ SESSION_LEASE_SECONDS: String(MAX_LEASE_SECONDS + 1) }),
    RegistryConfigError,
  );
  assert.equal(
    readRegistryConfig({ SESSION_LEASE_SECONDS: String(MAX_LEASE_SECONDS) }).leaseSeconds,
    MAX_LEASE_SECONDS,
  );
});

test('a misconfigured registry refuses the REQUEST with 500 — it does not serve a default', async () => {
  const h = harness({ MAX_CONCURRENT_SESSIONS: 'lots' });
  const { status, body } = await create(h);
  assert.equal(status, 500);
  assert.equal(body.error, 'registry_misconfigured');
  assert.match(body.detail, /MAX_CONCURRENT_SESSIONS/);
});

test('the lease can never outlive the LiveKit grant it is minted against', () => {
  // A slot held past its token's expiry is a slot nobody can occupy. The two
  // ceilings are the same number by import, and this pins the import.
  assert.equal(MAX_LEASE_SECONDS, MAX_LIVEKIT_TTL_SECONDS);
  assert.ok(DEFAULT_LEASE_SECONDS <= MAX_LEASE_SECONDS);
});

// ─── rule 4: nothing here may block hibernation ────────────────────────────

test('the Durable Object contains no timer and no WebSocket', () => {
  // A pending setTimeout/setInterval makes the object ineligible for
  // hibernation ENTIRELY — one stray line bills full wall clock with no other
  // symptom (ROADMAP.md §P1 rule 4). A non-hibernating WebSocket does the same
  // for its whole connected life (rule 3). Neither produces a failing test on
  // its own, so the check is structural.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'sessionRegistry.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // The stripper itself is discrimination-tested: those words appear in this
  // file's own comments explaining the rule, and an earlier guard in this repo
  // was tripped by exactly that. If comment-stripping ever breaks, these two
  // assertions fail before the scan below produces a false positive.
  assert.ok(!/hibernation/i.test(code), 'comment stripping is not working');
  assert.ok(/async alarm\(\)/.test(code), 'comment stripping removed real code');

  for (const forbidden of [/\bsetTimeout\b/, /\bsetInterval\b/, /\bWebSocket\b/]) {
    assert.ok(!forbidden.test(code), `SessionRegistry must not use ${forbidden}`);
  }
});

function parseJsonc(source) {
  return JSON.parse(
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1'),
  );
}

test('EVERY wrangler environment binds SessionRegistry and migrates it', async () => {
  // `class_name: "SessionRegistry"` resolves against the Worker's exports, so a
  // rename that missed one of the two would deploy and then fail at runtime on
  // the first session.
  const entry = await import('../src/index.js');
  assert.equal(entry.SessionRegistry, SessionRegistry);

  const config = parseJsonc(
    readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8'),
  );
  // Prove the parse before trusting it. A stripper that mangled the file into
  // something that happened to parse would make every assertion below vacuous.
  assert.equal(config.name, 'luminastream-api');
  assert.equal(config.env.staging.name, 'luminastream-api-staging');

  // Named environments inherit NEITHER durable_objects NOR migrations, so each
  // scope has to be checked on its own. The previous version of this test
  // grepped the file for one occurrence of each and would have passed happily
  // with staging missing both — a test that could not fail on the thing it
  // named.
  const scopes = [
    ['top-level', config],
    ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope]),
  ];
  assert.ok(scopes.length >= 2, 'there is at least one named environment to check');

  // TRIPWIRE. Staging has no agent, so staging must hand out no sessions —
  // otherwise it issues valid credentials for a room nobody serves, which is
  // the exact failure the room pool replaced. When a staging agent genuinely
  // runs, flip the var AND this assertion in the same commit; the point is that
  // turning staging on cannot be a one-character edit nobody reviews.
  assert.equal(
    config.env.staging.vars.SESSIONS_ENABLED,
    'false',
    'no agent serves the staging rooms — enabling sessions there promises silence',
  );

  for (const [where, scope] of scopes) {
    const bindings = scope.durable_objects?.bindings ?? [];
    assert.ok(
      bindings.some((b) => b.class_name === 'SessionRegistry' && b.name === 'SESSION_REGISTRY'),
      `${where} must bind SESSION_REGISTRY → SessionRegistry`,
    );
    // Not required to be the ONLY class — P2's SpendLedger lands in this same
    // list, and this assertion must not have to be rewritten when it does.
    const created = (scope.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
    assert.ok(
      created.includes('SessionRegistry'),
      `${where} migrations must create SessionRegistry (got ${JSON.stringify(created)})`,
    );
  }
});

// ─── the operator escape hatch ─────────────────────────────────────────────

test('reset releases every slot and clears the alarm', async () => {
  // Shipped after the first live drill found a slot held with no client left
  // to release it, and no recovery short of waiting out the two-hour lease.
  const h = harness();
  await create(h);
  await create(h);
  assert.equal((await capacity(h)).body.live, 2);
  assert.notEqual(h.pendingAlarm(), null);

  const { status, body } = await call(h, '/reset');
  assert.equal(status, 200);
  assert.equal(body.released, 2);
  assert.equal((await capacity(h)).body.live, 0);
  assert.equal(h.stored().size, 0);
  assert.equal(h.pendingAlarm(), null, 'nothing is pending, so nothing may wake the reaper');
});

test('reset on an empty registry is a no-op, not an error', async () => {
  const h = harness();
  const { status, body } = await call(h, '/reset');
  assert.equal(status, 200);
  assert.equal(body.released, 0);
});

test('a slot is reusable immediately after a reset', async () => {
  // The whole point: the lens works again without waiting for the lease.
  const h = harness({ SESSION_ROOMS: 'only-room', MAX_CONCURRENT_SESSIONS: '1' });
  const stuck = (await create(h)).body;
  assert.equal((await create(h)).status, 503, 'held');

  await call(h, '/reset');
  const fresh = (await create(h)).body;
  assert.equal(fresh.session.room, stuck.session.room, 'the same room, handed out again');
  assert.notEqual(fresh.session.id, stuck.session.id);
});

test('reset clears more than 128 slots without stranding any', async () => {
  const rooms = Array.from({ length: 200 }, (_, i) => `room-${i}`);
  const h = harness({ SESSION_ROOMS: rooms.join(','), MAX_CONCURRENT_SESSIONS: '200' });
  for (let i = 0; i < 200; i += 1) await create(h);

  assert.equal((await call(h, '/reset')).body.released, 200);
  assert.equal(h.stored().size, 0);
});
