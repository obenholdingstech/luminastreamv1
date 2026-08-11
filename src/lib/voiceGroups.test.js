// Run: node --test src/lib/voiceGroups.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupVoices, splitVoiceLabel } from './voiceGroups.js';

test('splitVoiceLabel: a known category suffix splits; anything else stays whole', () => {
  assert.deepEqual(splitVoiceLabel('Sarah - Mature, Reassuring, Confident (premade)'), {
    name: 'Sarah - Mature, Reassuring, Confident',
    category: 'premade',
  });
  assert.deepEqual(splitVoiceLabel('Amy (cloned)'), { name: 'Amy', category: 'cloned' });
  // a name's OWN parenthetical is not a category and must not be eaten
  assert.deepEqual(splitVoiceLabel('Bob (Laid-Back)'), { name: 'Bob (Laid-Back)', category: null });
  assert.deepEqual(splitVoiceLabel('Plain'), { name: 'Plain', category: null });
  assert.deepEqual(splitVoiceLabel(undefined), { name: '', category: null });
});

test('explicit broadcast categories win and group the selector', () => {
  const ids = ['a', 'b', 'c'];
  const labels = { a: 'Amy (cloned)', b: 'Roger (premade)', c: 'Gen (generated)' };
  const categories = { a: 'cloned', b: 'premade', c: 'generated' };
  const { personal, system } = groupVoices(ids, labels, categories);
  assert.deepEqual(personal, [
    { id: 'a', label: 'Amy' },
    { id: 'c', label: 'Gen' },
  ], 'account-created kinds are yours, order preserved, suffix dropped');
  assert.deepEqual(system, [{ id: 'b', label: 'Roger' }]);
});

test('label-parse fallback groups older broadcasts and the manifest', () => {
  // no categories map at all — the knobs.py "(category)" suffix carries it
  const ids = ['p', 'q'];
  const labels = { p: 'Sarah - Warm (premade)', q: 'Mine (cloned)' };
  const { personal, system } = groupVoices(ids, labels);
  assert.deepEqual(system, [{ id: 'p', label: 'Sarah - Warm' }]);
  assert.deepEqual(personal, [{ id: 'q', label: 'Mine' }]);
});

test('"your voices" is a positive claim — unknowns land on the system side, untouched', () => {
  const { personal, system } = groupVoices(['x', 'y'], { x: 'Mystery', y: 'Bob (Laid-Back)' });
  assert.deepEqual(personal, []);
  assert.deepEqual(system, [
    { id: 'x', label: 'Mystery' },
    { id: 'y', label: 'Bob (Laid-Back)' },
  ]);
});

test('a missing label falls back to the id; empty input yields empty groups', () => {
  const { personal, system } = groupVoices(['v9'], {}, { v9: 'cloned' });
  assert.deepEqual(personal, [{ id: 'v9', label: 'v9' }]);
  assert.deepEqual(groupVoices([], {}, {}), { personal: [], system: [] });
});
