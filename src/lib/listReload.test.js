// Run: node --test src/lib/listReload.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReloadSequence, foldListResponse } from './listReload.js';

test('only the newest intent applies — a superseded reload is refused', () => {
  const seq = createReloadSequence();
  const first = seq.begin();
  const second = seq.begin();
  assert.equal(seq.isCurrent(first), false, 'superseded');
  assert.equal(seq.isCurrent(second), true);
  // an intent with no fetch attached (sign-out) still supersedes in-flight
  seq.begin();
  assert.equal(seq.isCurrent(second), false, 'sign-out invalidates the pending response');
});

test('failure retains, answers replace — including the empty answer', () => {
  const known = [{ voiceId: 'c1' }];
  assert.equal(foldListResponse(known, null), known, 'a failed fetch keeps the last known list');
  assert.deepEqual(foldListResponse(known, []), [], 'an empty list is a real answer');
  const fresh = [{ voiceId: 'c2' }];
  assert.equal(foldListResponse(known, fresh), fresh);
});
