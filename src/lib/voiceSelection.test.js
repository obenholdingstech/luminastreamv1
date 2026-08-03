// Run: node --test src/lib/voiceSelection.test.js
//
// Each case below is one of the behaviors that was WRONG while this logic
// lived in Studio.jsx (CodeRabbit #53): a stale rejection resolving a fresh
// request, a pending state nothing could clear, and re-selecting the
// confirmed voice re-arming an abandoned request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSelector } from './voiceSelection.js';

const broadcast = (voice, rejectedVoiceReason) => ({
  config: { voice },
  rejected: rejectedVoiceReason ? { voice: rejectedVoiceReason } : null,
});

test('a request goes pending, and the confirming broadcast resolves it', async () => {
  const sent = [];
  const s = createVoiceSelector({ publish: (p) => (sent.push(p), true) });
  await s.request('voice-b', 'voice-a');
  assert.deepEqual(sent, [{ voice: 'voice-b' }]);
  assert.equal(s.snapshot().requested, 'voice-b');

  s.onBroadcast(broadcast('voice-b'));
  assert.deepEqual(s.snapshot(), { requested: null, rejection: null });
});

test('a rejection belongs to the request that produced it — a STALE one resolves nothing', async () => {
  const s = createVoiceSelector({ publish: () => true });

  // A rejection from some earlier exchange arrives while NOTHING is pending.
  s.onBroadcast(broadcast('voice-a', 'unknown voice_id (not on this account)'));
  assert.deepEqual(s.snapshot(), { requested: null, rejection: null }, 'no request, no verdict');

  // A fresh request must stay pending across that stale history…
  await s.request('voice-b', 'voice-a');
  assert.equal(s.snapshot().requested, 'voice-b', 'the new request is not cleared by old news');

  // …and resolve only on the broadcast that answers IT.
  s.onBroadcast(broadcast('voice-a', 'unknown voice_id (not on this account)'));
  const { requested, rejection } = s.snapshot();
  assert.equal(requested, null);
  assert.equal(rejection.voiceId, 'voice-b', 'the rejection names the voice that was asked for');
  assert.match(rejection.reason, /unknown voice_id/);
});

test('a periodic broadcast that neither confirms nor rejects keeps the request pending', async () => {
  const s = createVoiceSelector({ publish: () => true });
  await s.request('voice-b', 'voice-a');
  s.onBroadcast(broadcast('voice-a')); // still the old voice, no verdict
  assert.equal(s.snapshot().requested, 'voice-b', 'mid-flight broadcasts are not answers');
});

test('selecting the CONFIRMED voice publishes nothing and cancels a pending request', async () => {
  const sent = [];
  const s = createVoiceSelector({ publish: (p) => (sent.push(p), true) });
  await s.request('voice-b', 'voice-a'); // pending…
  await s.request('voice-a', 'voice-a'); // …user changes their mind back
  assert.equal(sent.length, 1, 'the status quo is never requested');
  assert.deepEqual(s.snapshot(), { requested: null, rejection: null });
});

test('a publish that fails resolves immediately with a visible reason — never a stuck pending', async () => {
  const s = createVoiceSelector({ publish: () => false });
  await s.request('voice-b', 'voice-a');
  const { requested, rejection } = s.snapshot();
  assert.equal(requested, null, 'nothing waits on an answer that can never come');
  assert.equal(rejection.voiceId, 'voice-b');
  assert.match(rejection.reason, /could not be sent/);
});

test('a publish that THROWS is a failed send, not an unhandled rejection', async () => {
  const s = createVoiceSelector({
    publish: () => {
      throw new Error('room gone');
    },
  });
  await assert.doesNotReject(() => Promise.resolve(s.request('voice-b', 'voice-a')));
});

test('reset() clears everything — disconnect leaves no pending question', async () => {
  const s = createVoiceSelector({ publish: () => true });
  await s.request('voice-b', 'voice-a');
  s.reset();
  assert.deepEqual(s.snapshot(), { requested: null, rejection: null });
});
