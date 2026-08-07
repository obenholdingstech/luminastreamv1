// Run: node --test — P5's rate table: the retail-decoupling mandate as
// arithmetic. Every rule here is a CEO mandate from ROADMAP §P5 (3 Aug
// 2026), so every rule gets a test that fails when it bends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_RATE_TABLE,
  RateTableError,
  convertAtReserve,
  parseRateTable,
  refundAtSettle,
} from '../src/rateTable.js';

const TABLE = parseRateTable({
  version: 3,
  meters: {
    decart_video_seconds: { cogsCentsPerUnit: 2, retailCentsPerUnit: 5 },
  },
});

// ── the margin floor is an invariant, not a hope ──────────────────────────

test('a retail rate below the COGS floor refuses to PARSE — selling at a loss cannot be an oversight', () => {
  assert.throws(
    () => parseRateTable({ version: 1, meters: { m: { cogsCentsPerUnit: 3, retailCentsPerUnit: 2 } } }),
    RateTableError,
  );
  // Equality is allowed — at-cost is a deliberate zero-margin declaration.
  const atCost = parseRateTable({ version: 1, meters: { m: { cogsCentsPerUnit: 3, retailCentsPerUnit: 3 } } });
  assert.equal(atCost.meters.m.retailCentsPerUnit, 3);
});

test('no floats near money — fractional cents refuse to parse', () => {
  for (const bad of [
    { cogsCentsPerUnit: 0.5, retailCentsPerUnit: 2 },
    { cogsCentsPerUnit: 0, retailCentsPerUnit: 1.01 },
    { cogsCentsPerUnit: -1, retailCentsPerUnit: 2 },
    { cogsCentsPerUnit: 0, retailCentsPerUnit: '2' },
  ]) {
    assert.throws(() => parseRateTable({ version: 1, meters: { m: bad } }), RateTableError, JSON.stringify(bad));
  }
  assert.throws(() => parseRateTable({ version: 1, meters: {} }), RateTableError, 'no meters');
  assert.throws(() => parseRateTable({ version: 1.5, meters: { m: { cogsCentsPerUnit: 0, retailCentsPerUnit: 1 } } }), RateTableError, 'fractional version');
});

// ── conversion: once, at reserve, house-favouring ─────────────────────────

test('convertAtReserve: CEIL, and the pin carries version + rate', () => {
  const r = convertAtReserve(TABLE, 'decart_video_seconds', 180);
  assert.deepEqual(r, { creditCents: 900, rateVersion: 3, rateCentsPerUnit: 5 });
  // Partial cents debit whole — 0.2 units at 5 cents = 1 whole cent.
  assert.equal(convertAtReserve(TABLE, 'decart_video_seconds', 0.2).creditCents, 1);
  assert.throws(() => convertAtReserve(TABLE, 'nope', 1), RateTableError, 'unknown meter');
  assert.throws(() => convertAtReserve(TABLE, 'decart_video_seconds', -1), RateTableError);
  assert.throws(() => convertAtReserve(TABLE, 'decart_video_seconds', NaN), RateTableError);
});

// ── refund: pinned rate only, FLOOR, clamped ──────────────────────────────

test('refundAtSettle: FLOOR at the PINNED rate — a rate change after reserve cannot touch the refund', () => {
  const pinned = convertAtReserve(TABLE, 'decart_video_seconds', 180);
  // 60 unused units at the pinned 5 → 300, regardless of any newer table.
  assert.equal(refundAtSettle(pinned, 180, 120), 300);
  // Partial cents stay with the house: 0.9 unused at 5 = 4.5 → 4.
  assert.equal(refundAtSettle(pinned, 120.9, 120), 4);
  // Over-usage refunds zero — never negative, never a minted credit.
  assert.equal(refundAtSettle(pinned, 180, 500), 0);
  // Negative "usage" cannot inflate the refund past the full grant.
  assert.equal(refundAtSettle(pinned, 180, -50), 900);
  // A settle without its pin is unanswerable — the record is the authority.
  assert.throws(() => refundAtSettle({}, 180, 120), RateTableError);
});

test('the dev table is 1:1 with a vacuous floor — a second is a second until wallets exist', () => {
  const r = convertAtReserve(DEV_RATE_TABLE, 'decart_video_seconds', 180);
  assert.equal(r.creditCents, 180);
  assert.equal(refundAtSettle(r, 180, 60), 120);
});

test('money boundaries: unsafe integers, NaN, strings, and frozen meters all refuse — CodeRabbit round 1', () => {
  const HUGE = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseRateTable({ version: 1, meters: { m: { cogsCentsPerUnit: 0, retailCentsPerUnit: HUGE } } }), RateTableError, 'unsafe rate');
  assert.throws(() => parseRateTable({ version: HUGE, meters: { m: { cogsCentsPerUnit: 0, retailCentsPerUnit: 1 } } }), RateTableError, 'unsafe version');
  // A debit whose product leaves the safe range refuses, never drifts.
  const maxRate = parseRateTable({ version: 1, meters: { m: { cogsCentsPerUnit: 0, retailCentsPerUnit: Number.MAX_SAFE_INTEGER } } });
  assert.throws(() => convertAtReserve(maxRate, 'm', 2), RateTableError, 'unsafe debit');
  // refund boundaries: NaN and string quantities are malformed summaries.
  const pinned = convertAtReserve(TABLE, 'decart_video_seconds', 10);
  assert.throws(() => refundAtSettle(pinned, NaN, 1), RateTableError);
  assert.throws(() => refundAtSettle(pinned, '10', 1), RateTableError);
  assert.throws(() => refundAtSettle(pinned, 10, NaN), RateTableError);
  assert.throws(() => refundAtSettle(pinned, 10, '1'), RateTableError);
  assert.throws(() => refundAtSettle(pinned, 10, Infinity), RateTableError, 'Infinity usage is malformed, not zero-refund');
  assert.throws(() => refundAtSettle(pinned, 10, -Infinity), RateTableError, '-Infinity must not grant a full refund');
  assert.throws(() => refundAtSettle(pinned, Infinity, 1), RateTableError);
  assert.throws(() => refundAtSettle({ rateCentsPerUnit: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, 0), RateTableError, 'unsafe refund');
  // The parsed table is deeply immutable — a mutated rate would bypass the
  // floor validation for every future reservation.
  assert.throws(() => {
    'use strict';
    TABLE.meters.decart_video_seconds.retailCentsPerUnit = 0;
  }, TypeError);
});
