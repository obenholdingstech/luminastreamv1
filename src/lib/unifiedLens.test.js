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

test('a NEW session fires again; reset clears the memory', () => {
  const latch = createAutoStartLatch();
  assert.equal(latch.shouldStart(ready()), true);
  assert.equal(latch.shouldStart(ready({ sessionId: 'sess-2' })), true, 'new session, new video');
  latch.reset();
  assert.equal(latch.shouldStart(ready({ sessionId: 'sess-2' })), true, 'reset forgets');
});
