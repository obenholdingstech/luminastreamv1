// Run: node --test src/lib/voiceLibrary.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_LIMIT_BYTES,
  afterClone,
  afterDelete,
  cloneLabel,
  sampleRefusal,
} from './voiceLibrary.js';

test('sampleRefusal: the PICK gate is 150MB (extraction shrinks it) — at it passes, over refuses, absent refuses', () => {
  assert.equal(sampleRefusal({ size: SAMPLE_LIMIT_BYTES }), null, 'exactly at the gate is fine');
  assert.match(sampleRefusal({ size: SAMPLE_LIMIT_BYTES + 1 }), /over 150MB/);
  assert.match(sampleRefusal(null), /no file/);
});

test('cloneLabel: extension off, trimmed, truncated, never empty', () => {
  assert.equal(cloneLabel('My Voice.mp3'), 'My Voice');
  assert.equal(cloneLabel('take.two.wav'), 'take.two', 'only the LAST extension goes');
  assert.equal(cloneLabel('  .mp3'), 'My voice', 'whitespace stem falls back');
  assert.equal(cloneLabel(undefined), 'My voice');
  assert.equal(cloneLabel(`${'x'.repeat(100)}.wav`).length, 60);
});

test('afterClone: success reloads and says so; a refusal repeats the server verbatim and touches nothing', () => {
  assert.deepEqual(afterClone({ ok: true, voiceId: 'v' }), {
    notice: 'voice cloned — it appears in the selector shortly',
    changed: true,
  });
  assert.deepEqual(afterClone({ ok: false, message: 'the wall said no' }), {
    notice: 'the wall said no',
    changed: false,
  });
  assert.equal(afterClone(undefined).changed, false, 'a missing result is a refusal');
});

test('afterDelete: the list reloads EITHER way — a failed delete may have drifted server state', () => {
  assert.deepEqual(afterDelete({ ok: true }), { notice: '', changed: true });
  const failed = afterDelete({ ok: false, message: 'vendor said no' });
  assert.equal(failed.notice, 'vendor said no');
  assert.equal(failed.changed, true, 'reload to whatever is actually true');
});
