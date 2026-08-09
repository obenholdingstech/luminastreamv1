// Run: node --test — the admin API (P8, pulled forward). The wall order and
// the one mutation's teeth: a suspended user's session dies at the NEXT
// request, because every resolver already filters status = 'active'.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const allowLimiter = { async limit() { return { success: true }; } };

function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7', Origin: 'https://admin.luminastream.live' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * A stateful fixture: users are LIVE rows — the status write mutates them
 * through the runMeta hook, and session resolution reads the mutated truth
 * (findAuthSession joins users on status = 'active' in real SQL; the fake
 * honours that by refusing a session whose user is suspended).
 */
async function world({ users = [] } = {}) {
  const sessions = new Map(); // tokenHash → userId
  const byId = (id) => users.find((u) => u.id === id);
  const cookies = {};
  for (const u of users) {
    const token = newSessionToken();
    sessions.set(await sessionTokenHash(token), u.id);
    cookies[u.id] = `${SESSION_COOKIE}=${token}`;
  }
  const d1 = createFakeD1({
    runMeta: (sql, binds) => {
      if (/UPDATE users SET status/.test(sql)) {
        const u = byId(binds[0]);
        if (u) u.status = binds[1];
      }
      return null;
    },
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql)) {
        const userId = sessions.get(binds[0]);
        const u = userId ? byId(userId) : null;
        // the real query joins users with status = 'active'
        if (!u || u.status !== 'active') return null;
        return {
          user_id: u.id,
          last_seen_at: Math.floor(Date.now() / 1000),
          display_name: u.name,
          role: u.role,
          verified: 1,
        };
      }
      if (/FROM users u ORDER BY/.test(sql)) {
        return users.map((u) => ({
          id: u.id,
          display_name: u.name,
          role: u.role,
          status: u.status,
          created_at: 1,
          email: `${u.id}@x.co`,
          verified: 1,
          voices: 0,
          avatars: 0,
        }));
      }
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
        return { total: users.length, active: users.filter((u) => u.status === 'active').length, suspended: 0, admins: 1 };
      }
      if (/FROM users WHERE id/.test(sql)) {
        const u = byId(binds[0]);
        return u ? { id: u.id, display_name: u.name, role: u.role, status: u.status } : null;
      }
      if (/FROM session_history/.test(sql)) return [];
      if (/FROM user_voices WHERE user_id/.test(sql)) return [];
      return null;
    },
  });
  const env = { IDENTITY_DB: d1, TOKEN_LIMITER: allowLimiter };
  return { d1, env, cookies, users };
}

const call = (r, env) => worker.fetch(r, env);

// ── the wall ──────────────────────────────────────────────────────────────

test('admin API: anonymous is 401, an ordinary user is 403, on every route', async () => {
  const { env, cookies } = await world({
    users: [{ id: 'u-user', name: 'u', role: 'user', status: 'active' }],
  });
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/sessions', '/api/admin/settlements']) {
    assert.equal((await call(req(path), env)).status, 401, `${path} anonymous`);
    const asUser = await call(req(path, { cookie: cookies['u-user'] }), env);
    assert.equal(asUser.status, 403, `${path} non-admin`);
    assert.equal((await asUser.json()).error, 'admin_only');
  }
  const mut = await call(
    req('/api/admin/users/u-user/status', { method: 'POST', cookie: cookies['u-user'], body: { status: 'suspended' } }),
    env,
  );
  assert.equal(mut.status, 403, 'the mutation is walled too');
});

test('admin API: the ops X-Admin-Token opens NONE of it — machine credentials do not administer people', async () => {
  const { env } = await world({ users: [] });
  const res = await worker.fetch(
    new Request('https://api.example/api/admin/users', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Admin-Token': 'any-ops-token' },
    }),
    { ...env, ADMIN_SESSION_SECRET: 'unit-test-session-secret' },
  );
  assert.equal(res.status, 401);
});

// ── the one mutation, and its teeth ───────────────────────────────────────

test('suspension has TEETH: the target session dies at its very next request', async () => {
  const { env, cookies } = await world({
    users: [
      { id: 'u-admin', name: 'Amy', role: 'admin', status: 'active' },
      { id: 'u-target', name: 'T', role: 'user', status: 'active' },
    ],
  });
  // The target is signed in and working.
  const before = await call(req('/api/me/voices', { cookie: cookies['u-target'] }), env);
  assert.equal(before.status, 200, 'the target has a live session');

  const sus = await call(
    req('/api/admin/users/u-target/status', { method: 'POST', cookie: cookies['u-admin'], body: { status: 'suspended' } }),
    env,
  );
  assert.equal(sus.status, 200);

  const after = await call(req('/api/me/voices', { cookie: cookies['u-target'] }), env);
  assert.equal(after.status, 401, 'the SAME cookie is dead — no new machinery, the resolvers already filter');

  // Reactivation restores.
  await call(
    req('/api/admin/users/u-target/status', { method: 'POST', cookie: cookies['u-admin'], body: { status: 'active' } }),
    env,
  );
  const restored = await call(req('/api/me/voices', { cookie: cookies['u-target'] }), env);
  assert.equal(restored.status, 200);
});

test('an admin cannot suspend themselves, and garbage statuses refuse', async () => {
  const { env, cookies } = await world({
    users: [{ id: 'u-admin', name: 'Amy', role: 'admin', status: 'active' }],
  });
  const self = await call(
    req('/api/admin/users/u-admin/status', { method: 'POST', cookie: cookies['u-admin'], body: { status: 'suspended' } }),
    env,
  );
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error, 'cannot_change_own_status');

  const junk = await call(
    req('/api/admin/users/u-admin/status', { method: 'POST', cookie: cookies['u-admin'], body: { status: 'banned' } }),
    env,
  );
  assert.equal(junk.status, 400);
  assert.equal((await junk.json()).error, 'status_invalid');

  const ghost = await call(
    req('/api/admin/users/u-ghost/status', { method: 'POST', cookie: cookies['u-admin'], body: { status: 'suspended' } }),
    env,
  );
  assert.equal(ghost.status, 404);
});

// ── reads render with a limb missing, never 500 ───────────────────────────

test('overview: missing DO bindings degrade to nulls — the console renders what it can', async () => {
  const { env, cookies } = await world({
    users: [{ id: 'u-admin', name: 'Amy', role: 'admin', status: 'active' }],
  });
  const res = await call(req('/api/admin/overview', { cookie: cookies['u-admin'] }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.users.total, 1);
  assert.equal(body.capacity, null, 'no registry binding → null, not 500');
  assert.equal(body.videoBudget, null, 'no ledger binding → null, not 500');
  assert.equal(body.voiceCloningEnabled, false);
});

test('users list: the console facts, and the legacy /api/admin/verify route is untouched', async () => {
  const { env, cookies } = await world({
    users: [
      { id: 'u-admin', name: 'Amy', role: 'admin', status: 'active' },
      { id: 'u-2', name: 'B', role: 'user', status: 'suspended' },
    ],
  });
  const res = await call(req('/api/admin/users', { cookie: cookies['u-admin'] }), env);
  const body = await res.json();
  assert.equal(body.users.length, 2);
  assert.equal(body.users[1].status, 'suspended');
  assert.equal(body.users[1].email, 'u-2@x.co');

  // The ops password endpoint predates this family and must keep answering
  // its own way (405 for GET), not fall into the new dispatch.
  const legacy = await call(req('/api/admin/verify'), env);
  assert.equal(legacy.status, 405);
});
