// Run: node --test src/lib/unifiedLens.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoStartLatch } from './unifiedLens.js';

const ready = (over = {}) => ({
  sessionId: 'sess-1',
  connected: true,
  adminToken: 'tok',
  videoPhase: 'off',
  ...over,
});

test('fires exactly once per session — a re-render is not a second vendor bill', () => {
  const latch = createAutoStartLatch();
  assert.equal(latch.shouldStart(ready()), true);
  assert.equal(latch.shouldStart(ready()), false, 'same session, never twice');
  assert.equal(latch.shouldStart(ready()), false);
});

test('a user who STOPPED video is not overridden — any non-off phase blocks', () => {
  const latch = createAutoStartLatch();
  for (const videoPhase of ['starting', 'live', 'stopping', 'error', 'limited']) {
    assert.equal(latch.shouldStart(ready({ videoPhase })), false, videoPhase);
  }
});

test('nothing fires before the session is real', () => {
  const latch = createAutoStartLatch();
  assert.equal(latch.shouldStart(ready({ sessionId: null })), false, 'no session');
  assert.equal(latch.shouldStart(ready({ connected: false })), false, 'not connected');
  assert.equal(latch.shouldStart(ready({ adminToken: null })), false, 'no token');
  // And none of those refusals consumed the latch:
  assert.equal(latch.shouldStart(ready()), true, 'the real moment still fires');
});

test('a NEW session fires again — being new is the only re-arm', () => {
  const latch = createAutoStartLatch();
  assert.equal(latch.shouldStart(ready()), true);
  assert.equal(latch.shouldStart(ready({ sessionId: 'sess-2' })), true, 'new session, new video');
});

// The 4 Aug incident, as a sequence: the user stops the lens, and for a few
// renders the OLD session identity is still visible while the video phase has
// already returned to 'off'. A latch that could be reset re-fired here and
// opened a second paid vendor session on a page that said "Lens off".
test('a stopped session can NEVER re-fire, however the teardown state flickers', () => {
  const latch = createAutoStartLatch();
  assert.equal(latch.shouldStart(ready()), true, 'the session starts once');
  assert.equal(typeof latch.reset, 'undefined', 'the reset footgun does not exist');
  for (const videoPhase of ['stopping', 'off', 'off']) {
    assert.equal(latch.shouldStart(ready({ videoPhase })), false, `mid-teardown: ${videoPhase}`);
  }
});

// ─── the pre-start voice choice ────────────────────────────────────────────

import { createVoicePreference } from './unifiedLens.js';

const voiceState = (over = {}) => ({
  sessionId: 'sess-1',
  connected: true,
  chosen: 'voice-b',
  confirmedVoice: 'voice-a',
  ...over,
});

test('the chosen voice applies once per session, after the agent has spoken', () => {
  const pref = createVoicePreference();
  assert.equal(pref.shouldApply(voiceState({ confirmedVoice: null })), false, 'no broadcast yet — wait');
  assert.equal(pref.shouldApply(voiceState()), true, 'agent spoke, choice differs — apply');
  assert.equal(pref.shouldApply(voiceState()), false, 'never twice for one session');
});

test('a choice the agent already confirmed sends nothing — and stays sent', () => {
  const pref = createVoicePreference();
  assert.equal(pref.shouldApply(voiceState({ chosen: 'voice-a' })), false, 'already true');
  assert.equal(
    pref.shouldApply(voiceState({ chosen: 'voice-a' })),
    false,
    'and the latch consumed the session — no late fire if state wobbles',
  );
});

test('a new session applies again — and there is no reset to misuse', () => {
  const pref = createVoicePreference();
  assert.equal(pref.shouldApply(voiceState()), true);
  assert.equal(pref.shouldApply(voiceState({ sessionId: 'sess-2' })), true);
  assert.equal(typeof pref.reset, 'undefined', 'same rule as the auto-start latch');
});

// ─── the crossfade ─────────────────────────────────────────────────────────

import { crossfadeState } from './unifiedLens.js';

test('ontrack BEFORE live: the preview holds until a frame is decoded', () => {
  // stream assigned, nothing decoded, not yet cinematic
  assert.deepEqual(
    crossfadeState({ streamPresent: true, transformedReady: false, cinematic: false }),
    { preview: 'visible', transformed: 'hidden' },
  );
  // decode lands first → ambient behind the ring; live flips it to full
  assert.deepEqual(
    crossfadeState({ streamPresent: true, transformedReady: true, cinematic: false }),
    { preview: 'hidden', transformed: 'ambient' },
  );
  assert.deepEqual(
    crossfadeState({ streamPresent: true, transformedReady: true, cinematic: true }),
    { preview: 'hidden', transformed: 'full' },
  );
});

test('live BEFORE decode: cinematic with no pixels is still the PREVIEW, not a black flash', () => {
  assert.deepEqual(
    crossfadeState({ streamPresent: true, transformedReady: false, cinematic: true }),
    { preview: 'visible', transformed: 'hidden' },
    'the fade starts only when there is something to fade TO',
  );
});

test('no stream (or a replaced one, ready reset) always returns the stage to the preview', () => {
  for (const cinematic of [false, true]) {
    assert.deepEqual(
      crossfadeState({ streamPresent: false, transformedReady: false, cinematic }),
      { preview: 'visible', transformed: 'hidden' },
    );
  }
  // ready without a stream is a stale flag, never a visible layer
  assert.deepEqual(
    crossfadeState({ streamPresent: false, transformedReady: true, cinematic: true }),
    { preview: 'visible', transformed: 'hidden' },
  );
});

// ─── the orphan reaper ─────────────────────────────────────────────────────

import { isOrphanVideoLeg } from './unifiedLens.js';

test('a video leg with no audio session is an orphan in every resource-holding phase', () => {
  // 'error' and 'limited' hold the camera they failed with — the negotiator
  // does not release media on a vendor error, so the reaper must claim them.
  for (const videoPhase of ['starting', 'live', 'error', 'limited']) {
    assert.equal(isOrphanVideoLeg({ hasCredentials: false, videoPhase }), true, videoPhase);
  }
});

test('a leg already out, or on its way out, is not reaped twice', () => {
  assert.equal(isOrphanVideoLeg({ hasCredentials: false, videoPhase: 'off' }), false, 'holds nothing');
  assert.equal(
    isOrphanVideoLeg({ hasCredentials: false, videoPhase: 'stopping' }),
    false,
    'already leaving — a second stop would race the first',
  );
});

test('inside a held session, NO phase is an orphan — failures there are the user\'s to see', () => {
  for (const videoPhase of ['off', 'starting', 'live', 'stopping', 'error', 'limited']) {
    assert.equal(isOrphanVideoLeg({ hasCredentials: true, videoPhase }), false, videoPhase);
  }
});

test('nothing applies without a session, a connection, or a choice', () => {
  const pref = createVoicePreference();
  assert.equal(pref.shouldApply(voiceState({ sessionId: null })), false);
  assert.equal(pref.shouldApply(voiceState({ connected: false })), false);
  assert.equal(pref.shouldApply(voiceState({ chosen: null })), false);
  assert.equal(pref.shouldApply(voiceState()), true, 'refusals did not consume the latch');
});
