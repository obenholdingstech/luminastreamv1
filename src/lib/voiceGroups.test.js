// Run: node --test src/lib/voiceGroups.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupVoices, mergeLibraryVoices, splitVoiceLabel, voiceKnobEntry } from './voiceGroups.js';

test('voiceKnobEntry: the wire shape is a LIST — the voice entry is found in it, never dotted off it', () => {
  const metadata = [
    { name: 'tts_model', kind: 'enum' },
    { name: 'voice', kind: 'enum', choices: ['v1'], choice_labels: { v1: 'Amy' } },
  ];
  assert.equal(voiceKnobEntry(metadata)?.choices[0], 'v1');
  assert.equal(voiceKnobEntry([{ name: 'stability' }]), null, 'no voice entry → null');
  assert.equal(voiceKnobEntry(null), null);
  assert.equal(voiceKnobEntry({ voice: { choices: ['x'] } }), null, 'a map is NOT the wire shape');
});

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

  // a CONFLICT is the only real test of precedence: the label claims
  // premade, the broadcast says cloned — the broadcast must win
  const conflict = groupVoices(['x'], { x: 'Voice (premade)' }, { x: 'cloned' });
  assert.deepEqual(conflict.personal.map(({ id }) => id), ['x']);
  assert.deepEqual(conflict.system, []);
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

test('the library reaches the selector without an agent — fresh clones appended as personal', () => {
  const broadcast = { choices: ['p1'], labels: { p1: 'Roger (premade)' }, categories: { p1: 'premade' } };
  const rows = [
    { id: 'row1', voiceId: 'c1', label: 'TEST VOICE', vendorAccount: 'k1234' },
    { id: 'row2', voiceId: 'c2', label: 'Mine Too', vendorAccount: 'k1234' },
  ];
  const merged = mergeLibraryVoices(broadcast, rows);
  assert.deepEqual(merged.choices, ['p1', 'c1', 'c2'], 'broadcast order first, library appended');
  assert.equal(merged.labels.c1, 'TEST VOICE');
  assert.equal(merged.categories.c1, 'cloned');
  const { personal } = groupVoices(merged.choices, merged.labels, merged.categories);
  assert.deepEqual(personal.map(({ id }) => id), ['c1', 'c2'], 'a fresh clone lands in "your voices"');
});

test('merge is broadcast-first: rows already offered change nothing, junk rows are skipped', () => {
  const broadcast = { choices: ['c1'], labels: { c1: 'Amy (cloned)' }, categories: { c1: 'cloned' } };
  const merged = mergeLibraryVoices(broadcast, [
    { voiceId: 'c1', label: 'stale db label' }, // broadcast label wins
    { voiceId: '', label: 'no id' },
    { label: 'missing voiceId entirely' },
    null,
  ]);
  assert.deepEqual(merged.choices, ['c1'], 'no duplicate, no junk');
  assert.equal(merged.labels.c1, 'Amy (cloned)', 'the broadcast label is kept');
  // a non-array library (failed fetch upstream) is a no-op, never a crash
  const untouched = mergeLibraryVoices(broadcast, null);
  assert.deepEqual(untouched.choices, ['c1']);
});

test('a missing label falls back to the id; empty input yields empty groups', () => {
  const { personal, system } = groupVoices(['v9'], {}, { v9: 'cloned' });
  assert.deepEqual(personal, [{ id: 'v9', label: 'v9' }]);
  assert.deepEqual(groupVoices([], {}, {}), { personal: [], system: [] });
});
