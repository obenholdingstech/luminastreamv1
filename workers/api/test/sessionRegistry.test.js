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
} from '../src/sessionRegistry.js';
import { MAX_LIVEKIT_TTL_SECONDS } from '../src/livekit.js';
import { createRegistryHarness, registryRequest } from '../testkit/registryHarness.js';

const T0 = Date.UTC(2026, 7, 2, 12, 0, 0);
const LEASE = 7200;
const ENV = { MAX_CONCURRENT_SESSIONS: '2', SESSION_LEASE_SECONDS: String(LEASE) };

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

test('create allocates a room, an identity, and a lease that matches the config', async () => {
  const h = harness();
  const { status, body } = await create(h);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.session.room, /^lumina-[0-9a-f-]{36}$/);
  assert.match(body.session.identity, /^speaker-[0-9a-f]{8}$/);
  assert.equal(body.session.createdAt, T0);
  assert.equal(body.session.expiresAt, T0 + LEASE * 1000);
  assert.equal(body.leaseSeconds, LEASE);
  assert.equal(body.live, 1);
  assert.equal(body.capacity, 2);
  assert.equal(typeof body.endToken, 'string');
  assert.ok(body.endToken.length >= 40, 'the release token must not be guessable');
});

test('two creates get different rooms and different identities', async () => {
  const h = harness();
  const a = (await create(h)).body;
  const b = (await create(h)).body;
  assert.notEqual(a.session.room, b.session.room);
  assert.notEqual(a.session.identity, b.session.identity);
  assert.notEqual(a.endToken, b.endToken);
});

test('the release token is never stored in the clear', async () => {
  const h = harness();
  const { endToken } = (await create(h)).body;
  const dump = JSON.stringify([...h.stored().values()]);
  assert.ok(!dump.includes(endToken), 'a storage dump must not hand over live sessions');
  assert.ok(dump.includes('endTokenHash'));
});

test('capacity reports live / capacity / available', async () => {
  const h = harness();
  assert.deepEqual((await capacity(h)).body, { ok: true, live: 0, capacity: 2, available: 0 + 2 });
  await create(h);
  assert.deepEqual((await capacity(h)).body, { ok: true, live: 1, capacity: 2, available: 1 });
  await create(h);
  assert.deepEqual((await capacity(h)).body, { ok: true, live: 2, capacity: 2, available: 0 });
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
  const h = harness({ MAX_CONCURRENT_SESSIONS: '300', SESSION_LEASE_SECONDS: String(LEASE) });
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
