// Run: node --test src/lib/knobState.test.js
// Pins the applied-truth rule: the badge value comes from the AGENT broadcast,
// and its state colors the relationship to the user's request.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { knobDisplay, knobState } from './knobState.js';

test('no agent broadcast yet → unknown, never the requested value', () => {
  assert.equal(knobState(0.9, undefined), 'unknown');
  assert.equal(knobState(0.9, null), 'unknown');
  assert.equal(knobDisplay(undefined), '—'); // requested 0.9 must NOT render
});

test('agent confirms the request → match', () => {
  assert.equal(knobState(0.75, 0.75), 'match');
  assert.equal(knobState(0.1 + 0.2, 0.3), 'match'); // float noise tolerated
  assert.equal(knobState('rmvpe', 'rmvpe'), 'match');
});

test('agent applied something else (clamp/reject) → mismatch', () => {
  assert.equal(knobState(1.5, 1.0), 'mismatch'); // out-of-range clamped
  assert.equal(knobState('dio', 'rmvpe'), 'mismatch'); // rejected enum kept old
});

test('user asked nothing → agent truth stands as match', () => {
  assert.equal(knobState(undefined, 0.33), 'match');
});

test('display renders the applied value, formatted', () => {
  assert.equal(knobDisplay(0.75), '0.75');
  assert.equal(knobDisplay(1.5), '1.5');
  assert.equal(knobDisplay(300), '300');
  assert.equal(knobDisplay('rmvpe'), 'rmvpe');
});

test('display renders booleans as on/off (the new bool knob)', () => {
  assert.equal(knobDisplay(true), 'on');
  assert.equal(knobDisplay(false), 'off');
  assert.equal(knobState(true, true), 'match');
  assert.equal(knobState(true, false), 'mismatch');
});
