// Run: node --test src/lib/avatarClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteAvatar,
  listAvatars,
  selectAvatar,
  uploadAvatar,
} from './avatarClient.js';

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
  const s = stub(200, { ok: true, avatars: [], id: 'x' });
  try {
    await listAvatars(BASE);
    await uploadAvatar({ imageData: 'AAAA' }, BASE);
    await selectAvatar('a'.repeat(32), BASE);
    await deleteAvatar('a'.repeat(32), BASE);
    for (const c of s.calls) {
      assert.equal(c.opts.credentials, 'include', c.url);
    }
  } finally {
    s.restore();
  }
});

test('a malformed ok list (avatars not an array) is a FAILED list, never a crash', async () => {
  for (const avatars of [undefined, null, 'nope', { 0: 'x' }]) {
    const s = stub(200, { ok: true, avatars });
    try {
      assert.equal(await listAvatars(BASE), null, JSON.stringify(avatars));
    } finally {
      s.restore();
    }
  }
});

test('an empty base is same-origin; only a MISSING base refuses', async () => {
  const s = stub(200, { ok: true, avatars: [{ id: 'a', name: 'x', size: 1, selected: true }] });
  try {
    const avatars = await listAvatars('');
    assert.equal(s.calls[0].url, '/api/me/avatars', 'relative, same-origin');
    assert.equal(avatars.length, 1);
  } finally {
    s.restore();
  }
  assert.equal(await listAvatars(null), null);
});

test('refusals map to prose; unknown codes stay generic; the fail-closed wall says WALL', async () => {
  for (const [code, pattern] of [
    ['avatars_unconfigured', /not switched on yet/],
    ['avatar_limit_reached', /avatar limit/],
    ['image_invalid', /could not be read as an image/],
    ['storage_unavailable', /did not answer/],
    ['something_new', /did not work/],
  ]) {
    const s = stub(400, { ok: false, error: code });
    try {
      const res = await uploadAvatar({ imageData: 'AAAA' }, BASE);
      assert.equal(res.ok, false);
      assert.match(res.message, pattern, code);
    } finally {
      s.restore();
    }
  }
});

test('a dead network is a refusal, not a crash', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  try {
    assert.equal((await deleteAvatar('a'.repeat(32), BASE)).ok, false);
    assert.equal((await selectAvatar('a'.repeat(32), BASE)).ok, false);
    assert.equal(await listAvatars(BASE), null);
  } finally {
    globalThis.fetch = original;
  }
});
