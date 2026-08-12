// Run: node --test src/lib/previewPlayer.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewSource, togglePreview } from './previewPlayer.js';

test('our vault wins for own voices; vendor clip covers system; absence is null', () => {
  assert.deepEqual(previewSource({ rowId: 'aa11', previewUrl: 'https://cdn/x.mp3', apiBase: 'https://api' }), {
    kind: 'sample',
    src: 'https://api/api/me/voices/aa11/sample',
  }, 'the user’s own sample outranks a vendor clip');
  assert.deepEqual(previewSource({ rowId: null, previewUrl: 'https://cdn/x.mp3' }), {
    kind: 'url',
    src: 'https://cdn/x.mp3',
  });
  assert.equal(previewSource({ rowId: null, previewUrl: '' }), null, 'no source, no player');
  assert.equal(previewSource({}), null);
});

test('one player: same id stops, another id switches', () => {
  assert.deepEqual(togglePreview(null, 'a'), { playingId: 'a', action: 'play' });
  assert.deepEqual(togglePreview('a', 'a'), { playingId: null, action: 'stop' });
  assert.deepEqual(togglePreview('a', 'b'), { playingId: 'b', action: 'play' });
});
