// Run: node --test src/lib/cloneFlow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneFormRefusal, runCloneFlow } from './cloneFlow.js';

const deps = (overrides = {}) => ({
  readFile: async () => 'data:audio/mpeg;base64,AAAA',
  clone: async () => ({ ok: true, voiceId: 'v-1' }),
  ...overrides,
});

test('an empty or whitespace name refuses before anything reads or uploads', async () => {
  assert.equal(cloneFormRefusal({ name: '' }), 'give the voice a name');
  assert.equal(cloneFormRefusal({ name: '   ' }), 'give the voice a name');
  assert.equal(cloneFormRefusal({ name: 'Me' }), null);
  let read = false;
  const out = await runCloneFlow(
    { file: {}, name: ' ' },
    deps({ readFile: async () => { read = true; return 'x'; } }),
  );
  assert.equal(out.ok, false);
  assert.equal(read, false, 'no file read for a refused form');
});

test('success carries the toast with the trimmed name; language rides only when chosen', async () => {
  const calls = [];
  const out = await runCloneFlow(
    { file: { type: 'audio/wav' }, name: '  My Voice  ', language: 'pt-BR' },
    deps({ clone: async (args) => { calls.push(args); return { ok: true }; } }),
  );
  assert.equal(out.ok, true);
  assert.match(out.toast, /“My Voice” is ready/);
  assert.equal(calls[0].name, 'My Voice');
  assert.equal(calls[0].language, 'pt-BR');
  assert.equal(calls[0].mimeType, 'audio/wav');

  await runCloneFlow({ file: {}, name: 'x' }, deps({ clone: async (a) => { calls.push(a); return { ok: true }; } }));
  assert.equal('language' in calls[1], false, 'auto-detect sends nothing');
});

test('a server refusal surfaces its words; a file-read failure has its own sentence', async () => {
  const refused = await runCloneFlow(
    { file: {}, name: 'x' },
    deps({ clone: async () => ({ ok: false, message: 'the wall said no' }) }),
  );
  assert.deepEqual(refused, { ok: false, error: 'the wall said no' });

  const unreadable = await runCloneFlow(
    { file: {}, name: 'x' },
    deps({ readFile: async () => { throw new Error('boom'); } }),
  );
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.error, /could not read that file/);
});
