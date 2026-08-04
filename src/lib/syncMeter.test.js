// Run: node --test src/lib/syncMeter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncMeter } from './syncMeter.js';

test('one utterance, one measurement: mouth at t, voice at t+1400 → 1400ms', () => {
  const m = createSyncMeter();
  m.localOnset(1000);
  assert.equal(m.remoteOnset(2400), 1400);
  assert.equal(m.lastMs(), 1400);
  assert.equal(m.medianMs(), 1400);
  assert.equal(m.count(), 1);
});

test('utterances pair FIFO — the conversation comes back in order', () => {
  const m = createSyncMeter();
  m.localOnset(0);
  m.localOnset(3000);
  assert.equal(m.remoteOnset(1500), 1500, 'first voice pairs the first mouth');
  assert.equal(m.remoteOnset(4800), 1800, 'second voice pairs the second mouth');
});

test('a dropped utterance expires instead of poisoning the next pairing', () => {
  const m = createSyncMeter({ maxDelayMs: 5000 });
  m.localOnset(0); // the agent dropped this one — its voice never comes
  m.localOnset(9000);
  // The voice for the SECOND utterance arrives; the first is past maxDelay.
  assert.equal(m.remoteOnset(10_500), 1500, 'paired with the living onset, not the ghost');
});

test('echo faster than the pipeline floor measures nothing and keeps the pending onset', () => {
  const m = createSyncMeter({ minDelayMs: 200 });
  m.localOnset(1000);
  assert.equal(m.remoteOnset(1100), null, '100ms is speaker bleed, not the returned voice');
  assert.equal(m.remoteOnset(2400), 1400, 'the real voice still pairs afterward');
});

test('a voice with no plausible mouth (agent greeting) measures nothing', () => {
  const m = createSyncMeter();
  assert.equal(m.remoteOnset(500), null);
  assert.equal(m.count(), 0);
});

test('the median answers over the window, not the last outlier', () => {
  const m = createSyncMeter({ window: 5 });
  const delays = [1400, 1500, 1450, 4000, 1480]; // one backlog spike
  let t = 0;
  for (const d of delays) {
    m.localOnset(t);
    m.remoteOnset(t + d);
    t += 20_000; // well past any expiry ambiguity
  }
  assert.equal(m.medianMs(), 1480, 'the spike informs, it does not rule');
});

test('pending is bounded — a monologue cannot grow memory', () => {
  const m = createSyncMeter({ maxPending: 3, maxDelayMs: 100_000 });
  for (let i = 0; i < 10; i += 1) m.localOnset(i * 1000);
  // Only the 3 newest (7000, 8000, 9000) survive; the voice pairs the oldest kept.
  assert.equal(m.remoteOnset(9000 + 500), 2500);
});

test('reset forgets pendings and measurements both', () => {
  const m = createSyncMeter();
  m.localOnset(0);
  m.remoteOnset(1500);
  m.reset();
  assert.equal(m.medianMs(), null);
  assert.equal(m.remoteOnset(2000), null, 'no ghost pending survives a reset');
});
