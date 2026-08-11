// Run: node --test src/lib/voicePicker.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVoiceGroups, matchesQuery, pickerEmptyLine } from './voicePicker.js';

const GROUPS = {
  personal: [
    { id: 'c1', label: 'TEST VOICE' },
    { id: 'c2', label: 'Celebrity lilcrush linda' },
  ],
  system: [
    { id: 'p1', label: 'Roger - Laid-Back, Casual, Resonant' },
    { id: 'p2', label: 'Sarah - Mature, Reassuring, Confident' },
  ],
};

test('tabs empty the excluded group and never reorder the kept one', () => {
  assert.deepEqual(filterVoiceGroups(GROUPS, { tab: 'all' }), GROUPS);
  const mine = filterVoiceGroups(GROUPS, { tab: 'mine' });
  assert.deepEqual(mine.personal.map((v) => v.id), ['c1', 'c2']);
  assert.deepEqual(mine.system, []);
  const system = filterVoiceGroups(GROUPS, { tab: 'system' });
  assert.deepEqual(system.personal, []);
  assert.deepEqual(system.system.map((v) => v.id), ['p1', 'p2']);
});

test('search filters BOTH groups, case-insensitive, blank keeps all', () => {
  const hit = filterVoiceGroups(GROUPS, { query: 'sar' });
  assert.deepEqual(hit.personal, []);
  assert.deepEqual(hit.system.map((v) => v.id), ['p2']);
  const both = filterVoiceGroups(GROUPS, { query: 'L' });
  assert.ok(both.personal.length > 0 && both.system.length > 0);
  assert.deepEqual(filterVoiceGroups(GROUPS, { query: '   ' }), GROUPS, 'whitespace is blank');
  assert.equal(matchesQuery(undefined, 'x'), false, 'no label cannot match a real query');
});

test('the empty line says WHY: query, empty library, or nothing at all', () => {
  const none = filterVoiceGroups(GROUPS, { query: 'zzz' });
  assert.equal(pickerEmptyLine(none, { query: 'zzz' }), 'nothing matches “zzz”');
  assert.equal(
    pickerEmptyLine({ personal: [], system: [] }, { tab: 'mine' }),
    'no cloned voices yet — clone one from a sample below',
  );
  assert.equal(pickerEmptyLine({ personal: [], system: [] }, {}), 'no voices available');
  assert.equal(pickerEmptyLine(GROUPS, {}), null, 'non-empty list needs no excuse');
});
