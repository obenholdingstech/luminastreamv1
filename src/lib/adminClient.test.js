// Run: node --test src/lib/adminClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchOverview,
  fetchSessions,
  fetchSettlements,
  fetchUsers,
  setUserStatus,
} from './adminClient.js';

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

test('every call is credentialed — the cookie is the only credential this console has', async () => {
  const s = stub(200, { ok: true, users: [], sessions: [], settlements: [] });
  try {
    await fetchOverview(BASE);
    await fetchUsers(BASE);
    await fetchSessions(BASE);
    await fetchSettlements(BASE);
    await setUserStatus('u1', 'suspended', BASE);
    for (const c of s.calls) assert.equal(c.opts.credentials, 'include', c.url);
  } finally {
    s.restore();
  }
});

test('malformed lists are FAILED reads — [null] and id-less users never reach the table', async () => {
  for (const users of [undefined, 'nope', [null], [{ noId: true }], [{ id: '' }]]) {
    const s = stub(200, { ok: true, users });
    try {
      assert.equal(await fetchUsers(BASE), null, JSON.stringify(users));
    } finally {
      s.restore();
    }
  }
});

test('refusals map to prose; the self-suspend guard reads as itself', async () => {
  const s = stub(400, { ok: false, error: 'cannot_change_own_status' });
  try {
    const res = await setUserStatus('me', 'suspended', BASE);
    assert.equal(res.ok, false);
    assert.match(res.message, /your own account/);
  } finally {
    s.restore();
  }
  const s2 = stub(403, { ok: false, error: 'admin_only' });
  try {
    assert.match((await setUserStatus('u2', 'active', BASE)).message, /not an admin/);
  } finally {
    s2.restore();
  }
});

test('a dead network is a null read / refusal, never a crash', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('down');
  };
  try {
    assert.equal(await fetchOverview(BASE), null);
    assert.equal((await setUserStatus('u1', 'active', BASE)).ok, false);
  } finally {
    globalThis.fetch = original;
  }
});
