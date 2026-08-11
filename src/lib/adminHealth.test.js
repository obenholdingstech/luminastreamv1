// Run: node --test src/lib/adminHealth.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentVerdict, formatCheckedAt, formatQuota, statusPill } from './adminHealth.js';

test('statusPill: the four known states plus an honest fallback', () => {
  assert.equal(statusPill('ok').word, 'ok');
  assert.equal(statusPill('payment').word, 'payment issue');
  assert.equal(statusPill('rejected').word, 'key rejected');
  assert.equal(statusPill('unreachable').word, 'unreachable');
  assert.equal(statusPill('weird').word, 'weird', 'unknown statuses render as themselves');
});

test('formatQuota: percent clamped, junk is null — never a crash input', () => {
  assert.deepEqual(formatQuota({ used: 300, limit: 1000 }), { percent: 30, text: '30% of 1,000' });
  assert.equal(formatQuota({ used: 2000, limit: 1000 }).percent, 100, 'overuse clamps');
  assert.equal(formatQuota(null), null);
  assert.equal(formatQuota({}), null);
  assert.equal(formatQuota({ used: 1, limit: 0 }), null);
});

test('formatCheckedAt: UTC seconds precision, junk is null', () => {
  assert.equal(formatCheckedAt(Date.UTC(2026, 7, 11, 12, 30, 45)), '2026-08-11 12:30:45');
  assert.equal(formatCheckedAt('now'), null);
  assert.equal(formatCheckedAt(0), null);
  assert.equal(formatCheckedAt(9e15), null, 'beyond the Date range fails soft, never RangeError');
});

test('agentVerdict: the live/down/unknown trichotomy', () => {
  assert.deepEqual(agentVerdict({ agentLive: true, agentIdentity: 'echo-1' }), { state: 'live', text: 'live — echo-1' });
  assert.deepEqual(agentVerdict({ agentLive: false }), { state: 'down', text: 'not serving' });
  assert.deepEqual(agentVerdict({ agentLive: null }), { state: 'unknown', text: 'unknown' });
  assert.deepEqual(agentVerdict(undefined), { state: 'unknown', text: 'unknown' });
});
