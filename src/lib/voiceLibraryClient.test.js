// Run: node --test src/lib/voiceLibraryClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneMyVoice, deleteMyVoice, listMyVoices } from './voiceLibraryClient.js';

const BASE = 'https://api.test';

function stub(status, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test('every call is credentialed — the cookie IS the identity', async () => {
  const s = stub(200, { ok: true, voices: [] });
  try {
    await listMyVoices(BASE);
    await cloneMyVoice({ name: 'x', sampleData: 'AAAA' }, BASE);
    await deleteMyVoice('id-1', BASE);
    for (const c of s.calls) {
      assert.equal(c.opts.credentials, 'include', c.url);
    }
  } finally {
    s.restore();
  }
});

test('the fail-closed wall arrives as prose that says WALL, not outage', async () => {
  const s = stub(503, { ok: false, error: 'voice_vendor_unconfigured' });
  try {
    const res = await cloneMyVoice({ name: 'x', sampleData: 'AAAA' }, BASE);
    assert.equal(res.ok, false);
    assert.match(res.message, /not switched on yet/);
  } finally {
    s.restore();
  }
});

test('refusals map to their own prose; unknown codes stay generic; success carries the vendor id', async () => {
  for (const [code, pattern] of [
    ['voice_limit_reached', /voice limit/],
    ['verification_required', /verify your email/],
    ['sample_invalid', /could not be read as audio/],
    ['voice_clone_rejected', /refused this sample/],
    ['something_new', /did not work/],
  ]) {
    const s = stub(400, { ok: false, error: code });
    try {
      const res = await cloneMyVoice({ name: 'x', sampleData: 'AAAA' }, BASE);
      assert.match(res.message, pattern, code);
    } finally {
      s.restore();
    }
  }
  const ok = stub(200, { ok: true, id: 'row', voiceId: 'v-1', label: 'x' });
  try {
    assert.deepEqual(await cloneMyVoice({ name: 'x', sampleData: 'AAAA' }, BASE), {
      ok: true,
      voiceId: 'v-1',
    });
  } finally {
    ok.restore();
  }
});

test('a dead network is a refusal, not a crash; no base is a null list', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  try {
    const res = await deleteMyVoice('id-1', BASE);
    assert.equal(res.ok, false);
    assert.equal(await listMyVoices(BASE), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty base is same-origin — the relative endpoint is called, not refused', async () => {
  const s = stub(200, { ok: true, voices: [{ id: 'r', voiceId: 'v', label: 'x' }] });
  try {
    const voices = await listMyVoices('');
    assert.equal(s.calls[0].url, '/api/me/voices', 'relative, same-origin');
    assert.equal(voices.length, 1);
  } finally {
    s.restore();
  }
  assert.equal(await listMyVoices(null), null, 'only a MISSING base refuses');
});

test('a malformed ok response (voices not an array) is a FAILED list, never a crash', async () => {
  for (const voices of [undefined, null, 'nope', { 0: 'x' }]) {
    const s = stub(200, { ok: true, voices });
    try {
      assert.equal(await listMyVoices(BASE), null, JSON.stringify(voices));
    } finally {
      s.restore();
    }
  }
});

test('cloneMyVoice: the language field rides the body when present, and only then', async () => {
  const s = stub(200, { ok: true, id: 'row', voiceId: 'v-1', label: 'x' });
  try {
    await cloneMyVoice({ name: 'x', sampleData: 'AAAA', language: 'pt-BR' }, BASE);
    assert.equal(JSON.parse(s.calls[0].opts.body).language, 'pt-BR');
    await cloneMyVoice({ name: 'x', sampleData: 'AAAA' }, BASE);
    assert.equal('language' in JSON.parse(s.calls[1].opts.body), false);
  } finally {
    s.restore();
  }
});
