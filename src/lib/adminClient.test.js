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

const GOOD_USER = {
  id: 'u1', email: 'a@b.co', displayName: 'A', role: 'user', status: 'active',
  verified: true, createdAt: 1, voices: 0, avatars: 0,
};

test('malformed lists are FAILED reads — every rendered field is required', async () => {
  for (const users of [
    undefined,
    'nope',
    [null],
    [{ noId: true }],
    [{ id: '' }],
    [{ ...GOOD_USER, status: undefined }],
    [{ ...GOOD_USER, verified: 'yes' }],
    [{ ...GOOD_USER, voices: 'three' }],
    [{ ...GOOD_USER, createdAt: -5 }],
    [GOOD_USER, null],
  ]) {
    const s = stub(200, { ok: true, users });
    try {
      assert.equal(await fetchUsers(BASE), null, JSON.stringify(users));
    } finally {
      s.restore();
    }
  }
  const ok = stub(200, { ok: true, users: [GOOD_USER] });
  try {
    assert.equal((await fetchUsers(BASE)).length, 1, 'a fully-formed row passes');
  } finally {
    ok.restore();
  }
});

test('a malformed overview is a FAILED read — the console never invents zeros', async () => {
  const GOOD = {
    ok: true,
    users: { total: 2, active: 1, suspended: 1, admins: 1 },
    capacity: null,
    videoBudget: null,
    voiceCloningEnabled: false,
  };
  for (const bad of [
    { ...GOOD, users: undefined },
    { ...GOOD, users: { total: 2 } },
    { ...GOOD, users: { ...GOOD.users, active: 'one' } },
    { ...GOOD, voiceCloningEnabled: 'yes' },
    { ...GOOD, capacity: 'up' },
  ]) {
    const s = stub(200, bad);
    try {
      assert.equal(await fetchOverview(BASE), null, JSON.stringify(bad));
    } finally {
      s.restore();
    }
  }
  const ok = stub(200, GOOD);
  try {
    assert.equal((await fetchOverview(BASE)).users.total, 2);
  } finally {
    ok.restore();
  }
});

test('malformed session and settlement rows are FAILED reads — tables never dereference junk', async () => {
  for (const sessions of [[null], [{ id: 's1' }], [{ id: 's1', room: 'r', started_at: 'now' }]]) {
    const s = stub(200, { ok: true, sessions });
    try {
      assert.equal(await fetchSessions(BASE), null, JSON.stringify(sessions));
    } finally {
      s.restore();
    }
  }
  for (const settlements of [[null], [{ grantedSeconds: 10 }], [{ reservationId: 'r', grantedSeconds: 10, usedSeconds: 'all' }]]) {
    const s = stub(200, { ok: true, settlements });
    try {
      assert.equal(await fetchSettlements(BASE), null, JSON.stringify(settlements));
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
