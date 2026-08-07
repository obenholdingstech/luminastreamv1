// Run: node --test workers/api/test/spendLedger.test.js
//
// The SpendLedger's own behaviour, driven directly. This object graduates
// from dev caps to user wallets with the SAME code paths (ROADMAP §P2), so
// every test here is really a test about someone's money arriving later:
// does the grant respect the balance, can a settle move more than it should,
// does abandonment resolve in the house's favour, can a stranger's request
// touch the meter at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SpendLedger,
  readLedgerConfig,
  LedgerConfigError,
  DEFAULT_MAX_VIDEO_SECONDS_PER_SESSION,
  DEFAULT_MAX_VIDEO_SECONDS_TOTAL,
  SETTLE_SLACK_SECONDS,
} from '../src/spendLedger.js';
import { createRegistryHarness, registryRequest } from '../testkit/registryHarness.js';

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0);
const ENV = {
  MAX_VIDEO_SECONDS_PER_SESSION: '180',
  MAX_VIDEO_SECONDS_TOTAL: '600',
};

function harness(env = ENV) {
  return createRegistryHarness({ env, startAt: T0, cls: SpendLedger });
}

async function call(h, path, body) {
  const res = await h.instance.fetch(registryRequest(path, body));
  return { status: res.status, body: await res.json() };
}

const reserve = (h, body) => call(h, '/reserve', body);
const settle = (h, body) => call(h, '/settle', body);
const budget = (h) => call(h, '/budget');

// ─── the grant respects every bound ────────────────────────────────────────

test('reserve grants min(requested, session cap, remaining) — never more', async () => {
  const h = harness();
  assert.equal((await reserve(h, { requestedSeconds: 60 })).body.grantedSeconds, 60);
  assert.equal((await reserve(h)).body.grantedSeconds, 180, 'absent request → full session cap');
  assert.equal(
    (await reserve(h, { requestedSeconds: 9999 })).body.grantedSeconds,
    180,
    'a greedy request is clamped to the session cap',
  );
  // 60 + 180 + 180 spent of 600 → 180 remain
  const last = (await reserve(h, { requestedSeconds: 500 })).body;
  assert.equal(last.grantedSeconds, 180, 'the last grant is clamped to what remains');
  assert.equal(last.remainingSeconds, 0);
});

test('garbage requestedSeconds falls back to the session cap, never to more', async () => {
  const h = harness();
  for (const bad of ['60', -5, 0, 1.5, null, {}]) {
    const { body } = await reserve(h, { requestedSeconds: bad });
    assert.equal(body.grantedSeconds, 180, `requestedSeconds=${JSON.stringify(bad)}`);
    await settle(h, { reservationId: body.reservationId, settleToken: body.settleToken, usedSeconds: 0 });
  }
});

test('an exhausted budget refuses with its own code — the wall WORKING, not an outage', async () => {
  const h = harness({ ...ENV, MAX_VIDEO_SECONDS_TOTAL: '180' });
  await reserve(h);
  const { status, body } = await reserve(h);
  assert.equal(status, 503);
  assert.equal(body.error, 'video_budget_exhausted');
  assert.equal(body.spentSeconds, 180);
});

test('the balance is DEBITED at reserve, not at settle', async () => {
  const h = harness();
  await reserve(h, { requestedSeconds: 100 });
  const b = (await budget(h)).body;
  assert.equal(b.spentSeconds, 100, 'the hold is spend until proven otherwise');
  assert.equal(b.remainingSeconds, 500);
  assert.equal(b.openReservations, 1);
});

// ─── settle: money can only move the right way ─────────────────────────────

test('settle credits back the unused part of the hold', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 100 })).body;
  const s = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 30 })).body;
  assert.equal(s.settled, true);
  assert.equal(s.usedSeconds, 30);
  assert.equal(s.refundedSeconds, 70);
  assert.equal((await budget(h)).body.spentSeconds, 30);
});

test('a settle can NEVER exceed its reserve — usage is clamped to the grant', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 50 })).body;
  const s = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 9999 })).body;
  assert.equal(s.usedSeconds, 50, 'no request shape can spend more than was authorized');
  assert.equal(s.refundedSeconds, 0);
});

test('garbage usage settles as FULLY SPENT — the conservative reading', async () => {
  const h = harness();
  for (const bad of [-1, 1.5, '30', null, undefined]) {
    const r = (await reserve(h, { requestedSeconds: 40 })).body;
    const s = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: bad })).body;
    assert.equal(s.usedSeconds, 40, `usedSeconds=${JSON.stringify(bad)} must not become a refund`);
  }
});

test('a WRONG settle token moves nothing, and the hold stands', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 80 })).body;
  const { status, body } = await settle(h, {
    reservationId: r.reservationId,
    settleToken: 'guessed',
    usedSeconds: 0,
  });
  assert.equal(status, 403);
  assert.equal(body.error, 'settle_refused');
  assert.equal((await budget(h)).body.spentSeconds, 80, 'a wrong bearer must never move money');
});

test('a second settle credits NOTHING — no double refund', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 100 })).body;
  await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 20 });
  const again = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 20 })).body;
  assert.equal(again.ok, true, 'a retried settle must not read as failure');
  assert.equal(again.settled, false);
  assert.equal(again.reason, 'unknown_reservation');
  assert.equal((await budget(h)).body.spentSeconds, 20, 'the refund happened exactly once');
});

test('the settle token is never stored in the clear', async () => {
  const h = harness();
  const r = (await reserve(h)).body;
  const dump = JSON.stringify([...h.stored().values()]);
  assert.ok(!dump.includes(r.settleToken), 'a storage dump must not hand over live refund rights');
});

// ─── abandonment resolves in the house's favour ────────────────────────────

test('an expired unsettled reservation is reaped AS SPENT — the debit stands', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 60 })).body;
  await h.advanceBy((60 + SETTLE_SLACK_SECONDS + 1) * 1000);

  assert.equal(h.counts().alarms, 1, 'one demand-driven wakeup');
  assert.equal((await budget(h)).body.openReservations, 0);
  assert.equal((await budget(h)).body.spentSeconds, 60, 'abandonment must not refund');

  // And a settle arriving AFTER the reap credits nothing.
  const late = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 0 })).body;
  assert.equal(late.settled, false);
  assert.equal((await budget(h)).body.spentSeconds, 60);
});

test('a settle AFTER expiry but BEFORE the alarm refunds NOTHING', async () => {
  // Cloudflare can delay or retry alarm delivery, so "expired but not yet
  // reaped" is a reachable production state — the registry learned this for
  // slots, and money holds the same rule harder. warpBy crosses the expiry
  // WITHOUT firing the alarm, which is exactly the window; the earlier
  // version of this suite only used advanceBy, which fires the alarm first
  // and therefore could not see this bug. It shipped one.
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 60 })).body;
  h.warpBy((60 + SETTLE_SLACK_SECONDS + 1) * 1000);
  assert.equal(h.counts().alarms, 0, 'the window: expired, alarm not yet delivered');

  const late = (await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 0 })).body;
  assert.equal(late.ok, true);
  assert.equal(late.settled, false, 'an expired hold has already resolved as spent');
  assert.equal((await budget(h)).body.spentSeconds, 60, 'no refund through the delayed-alarm window');
});

test('a clean reserve→settle never wakes the reaper; abandonment costs exactly one alarm', async () => {
  const clean = harness();
  const r = (await reserve(clean, { requestedSeconds: 30 })).body;
  await settle(clean, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 30 });
  await clean.advanceBy(24 * 60 * 60 * 1000);
  assert.equal(clean.counts().alarms, 0);
  assert.equal(clean.pendingAlarm(), null);

  const abandoned = harness();
  await reserve(abandoned, { requestedSeconds: 30 });
  await abandoned.advanceBy(7 * 24 * 60 * 60 * 1000);
  assert.equal(abandoned.counts().alarms, 1, 'one wakeup no matter how long the silence');
  assert.equal(abandoned.pendingAlarm(), null);
});

// ─── configuration: malformed is fatal ─────────────────────────────────────

test('defaults apply when nothing is configured', () => {
  const c = readLedgerConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.perSessionSeconds, DEFAULT_MAX_VIDEO_SECONDS_PER_SESSION);
  assert.equal(c.totalSeconds, DEFAULT_MAX_VIDEO_SECONDS_TOTAL);
});

test('malformed ceilings and switches are FATAL, never silent defaults', () => {
  for (const bad of ['lots', '-1', '0', '1.5']) {
    assert.throws(() => readLedgerConfig({ MAX_VIDEO_SECONDS_PER_SESSION: bad }), LedgerConfigError);
    assert.throws(() => readLedgerConfig({ MAX_VIDEO_SECONDS_TOTAL: bad }), LedgerConfigError);
  }
  for (const bad of ['yes', '1', 'flase']) {
    assert.throws(() => readLedgerConfig({ VIDEO_ENABLED: bad }), LedgerConfigError);
  }
  assert.equal(readLedgerConfig({ VIDEO_ENABLED: ' False ' }).enabled, false);
});

test('a disabled ledger refuses reserves with its own code', async () => {
  const h = harness({ ...ENV, VIDEO_ENABLED: 'false' });
  const { status, body } = await reserve(h);
  assert.equal(status, 503);
  assert.equal(body.error, 'video_disabled');
});

test('a misconfigured ledger refuses the request with 500 — never a default grant', async () => {
  const h = harness({ MAX_VIDEO_SECONDS_TOTAL: 'unlimited' });
  const { status, body } = await reserve(h);
  assert.equal(status, 500);
  assert.equal(body.error, 'ledger_misconfigured');
});

// ─── reset: the dev-card re-arm ────────────────────────────────────────────

test('reset zeroes the meter and drops every hold', async () => {
  const h = harness();
  await reserve(h);
  await reserve(h);
  const { body } = await call(h, '/reset');
  assert.equal(body.released, 2);
  const b = (await budget(h)).body;
  assert.equal(b.spentSeconds, 0);
  assert.equal(b.openReservations, 0);
  assert.equal(h.pendingAlarm(), null);
});

// ─── structure: nothing here may block hibernation ─────────────────────────

test('the SpendLedger contains no timer and no WebSocket', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'spendLedger.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/async alarm\(\)/.test(code), 'comment stripping removed real code');
  for (const forbidden of [/\bsetTimeout\b/, /\bsetInterval\b/, /\bWebSocket\b/]) {
    assert.ok(!forbidden.test(code), `SpendLedger must not use ${forbidden}`);
  }
});

test('EVERY wrangler environment binds SpendLedger and migrates it', async () => {
  const entry = await import('../src/index.js');
  assert.equal(entry.SpendLedger, SpendLedger);

  const raw = readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  const config = JSON.parse(
    raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1'),
  );
  assert.equal(config.name, 'luminastream-api');

  const scopes = [
    ['top-level', config],
    ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope]),
  ];
  assert.ok(scopes.length >= 2);
  for (const [where, scope] of scopes) {
    const bindings = scope.durable_objects?.bindings ?? [];
    assert.ok(
      bindings.some((b) => b.class_name === 'SpendLedger' && b.name === 'VIDEO_LEDGER'),
      `${where} must bind VIDEO_LEDGER → SpendLedger`,
    );
    const created = (scope.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
    assert.ok(created.includes('SpendLedger'), `${where} migrations must create SpendLedger`);
    for (const v of ['VIDEO_ENABLED', 'MAX_VIDEO_SECONDS_PER_SESSION', 'MAX_VIDEO_SECONDS_TOTAL']) {
      assert.ok(scope.vars?.[v] !== undefined, `${where} must set ${v}`);
    }
    assert.ok(
      (scope.ratelimits ?? []).some((r) => r.name === 'VIDEO_LIMITER'),
      `${where} must carry VIDEO_LIMITER`,
    );
  }
});

// ─── P5: the pin at reserve, the refund at the pin ─────────────────────────

test('P5: the reservation pins {version, rate, debit} at reserve, and the settlement refunds at the PIN', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 100 })).body;
  const record = await h.storage.get(`reservation:${r.reservationId}`);
  assert.equal(record.rateVersion, 1, 'the dev table version rides the record');
  assert.equal(record.rateCentsPerUnit, 1, '1:1 — a second is a credit-cent in dev');
  assert.equal(record.debitCents, 100, 'the ONE conversion happened at reserve');

  await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 40 });
  const s = await h.storage.get(`settlement:${r.reservationId}`);
  assert.equal(s.refundCents, 60, 'refund at the pinned rate');
  assert.equal(s.deductedCents, 40, 'deducted = debit − refund');
  assert.equal(s.rateVersion, 1, 'the pin travels into the audit row');
});

test('P5: the refund uses the RECORD pin, not any current table — a rate change cannot touch an open hold', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 100 })).body;
  // Simulate a rate change landing mid-session: rewrite the record's pin to
  // an older, different rate (as a reservation made under table v1 would
  // look after a v2 deploy). The settle must honour the record.
  const record = await h.storage.get(`reservation:${r.reservationId}`);
  record.rateCentsPerUnit = 7;
  record.rateVersion = 99;
  record.debitCents = 700;
  await h.storage.put(`reservation:${r.reservationId}`, record);

  await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 40 });
  const s = await h.storage.get(`settlement:${r.reservationId}`);
  assert.equal(s.refundCents, 420, '60 unused × the PINNED 7 — never the current table');
  assert.equal(s.rateVersion, 99, 'the pin is the audit truth');
});

test('P5: a legacy record without a pin settles cleanly with no credit fields — rollout safety', async () => {
  const h = harness();
  const r = (await reserve(h, { requestedSeconds: 50 })).body;
  const record = await h.storage.get(`reservation:${r.reservationId}`);
  delete record.rateVersion;
  delete record.rateCentsPerUnit;
  delete record.debitCents;
  await h.storage.put(`reservation:${r.reservationId}`, record);

  const out = await settle(h, { reservationId: r.reservationId, settleToken: r.settleToken, usedSeconds: 10 });
  assert.equal(out.body.ok, true, 'an in-flight pre-P5 hold settles, never 500s');
  const s = await h.storage.get(`settlement:${r.reservationId}`);
  assert.equal(s.refundCents, undefined, 'no pin, no credit fields — seconds accounting stands alone');
  assert.equal(s.usedSeconds, 10, 'the seconds trail is untouched');
});
