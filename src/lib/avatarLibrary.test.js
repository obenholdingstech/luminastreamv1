// Run: node --test src/lib/avatarLibrary.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterDelete, afterSelect, afterUpload } from './avatarLibrary.js';

test('afterUpload: success reloads and carries the new id; a refusal repeats the server and touches nothing', () => {
  assert.deepEqual(afterUpload({ ok: true, id: 'av-1' }), {
    notice: 'avatar saved — it is now your selected identity',
    changed: true,
    id: 'av-1',
  });
  assert.deepEqual(afterUpload({ ok: false, message: 'the wall said no' }), {
    notice: 'the wall said no',
    changed: false,
    id: null,
  });
  assert.equal(afterUpload({ ok: true }).changed, false, 'ok without an id is not a success');
  assert.equal(afterUpload(undefined).changed, false, 'a missing result is a refusal');
});

test('afterSelect: success is silent and reloads; a refusal says why and changes nothing', () => {
  assert.deepEqual(afterSelect({ ok: true }), { notice: '', changed: true });
  assert.deepEqual(afterSelect({ ok: false, message: 'gone' }), { notice: 'gone', changed: false });
});

test('afterDelete: the list reloads EITHER way — a failed delete may have drifted server state', () => {
  assert.deepEqual(afterDelete({ ok: true }), { notice: '', changed: true });
  const failed = afterDelete({ ok: false, message: 'storage said no' });
  assert.equal(failed.notice, 'storage said no');
  assert.equal(failed.changed, true);
});
