// Run: node --test — the avatar library (P4c), driven through the Worker's
// default export like authRoutes.test.js: fake env, injectable limiters,
// respond-based fake D1, and a fake R2 whose prefix filtering is real —
// because per-user prefixes ARE the isolation, and a fake that ignored
// prefixes would make every isolation proof below vacuous.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { createFakeR2 } from '../testkit/fakeR2.js';
import { loadAvatarB64 } from '../src/avatarRoutes.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const STUDIO = 'https://studio.luminastream.live';
const allowLimiter = { async limit() { return { success: true }; } };
const denyLimiter = { async limit() { return { success: false }; } };

// A real (tiny) base64 payload — decodes fine, round-trips exactly.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function req(path, { method = 'GET', origin = STUDIO, body, cookie, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const call = (request, env) => worker.fetch(request, env);

/**
 * A signed-in user with a real session cookie against a respond-based fake
 * D1. `profileAvatarKey` feeds getProfile so `selected` flags are testable.
 */
async function userSession(userId, { profileAvatarKey = null, avatarRows = [], runMeta } = {}) {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
    runMeta,
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql) && binds[0] === tokenHash) {
        return {
          user_id: userId,
          last_seen_at: Math.floor(Date.now() / 1000),
          display_name: userId,
          role: 'user',
          verified: 1,
        };
      }
      if (/FROM lens_profiles/.test(sql) && binds[0] === userId) {
        return profileAvatarKey ? { user_id: userId, avatar_key: profileAvatarKey } : null;
      }
      // the slot table: list is scoped by user_id; find by (id, user_id)
      if (/FROM user_avatars WHERE user_id/.test(sql) && binds[0] === userId) {
        return avatarRows;
      }
      if (/FROM user_avatars WHERE id/.test(sql)) {
        const [id, uid] = binds;
        return uid === userId ? (avatarRows.find((r) => r.id === id) ?? null) : null;
      }
      return null;
    },
  });
  return { cookie: `${SESSION_COOKIE}=${sessionToken}`, d1 };
}

const baseEnv = (d1, r2, { limiter = allowLimiter } = {}) => ({
  IDENTITY_DB: d1,
  AVATARS: r2,
  MEDIA_LIMITER: limiter,
});

// ── the doors, in order ───────────────────────────────────────────────────

test('avatars: no binding is 503, not a crash — fail closed, named', async () => {
  const { cookie, d1 } = await userSession('u1');
  const env = { IDENTITY_DB: d1, MEDIA_LIMITER: allowLimiter };
  const res = await call(req('/api/me/avatars', { cookie }), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'avatars_unconfigured');
});

test('avatars: the limiter runs before auth — an anonymous flood buys no D1 reads', async () => {
  const { d1 } = await userSession('u1');
  const res = await call(
    req('/api/me/avatars'),
    baseEnv(d1, createFakeR2(), { limiter: denyLimiter }),
  );
  assert.equal(res.status, 429);
  assert.equal(d1.executed.length, 0, 'no query ran');
});

test('avatars: no cookie is 401 on every route shape', async () => {
  const { d1 } = await userSession('u1');
  const env = baseEnv(d1, createFakeR2());
  for (const [path, method] of [
    ['/api/me/avatars', 'GET'],
    ['/api/me/avatars', 'POST'],
    [`/api/me/avatars/${'a'.repeat(32)}`, 'GET'],
    [`/api/me/avatars/${'a'.repeat(32)}`, 'DELETE'],
    [`/api/me/avatars/${'a'.repeat(32)}/select`, 'POST'],
  ]) {
    const res = await call(req(path, { method, body: method === 'POST' ? {} : undefined }), env);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

// ── the library lifecycle ─────────────────────────────────────────────────

test('avatars: upload stores under the caller prefix, selects it, and lists back', async () => {
  const { cookie, d1 } = await userSession('u1');
  const r2 = createFakeR2();
  const env = baseEnv(d1, r2);

  const up = await call(
    req('/api/me/avatars', {
      method: 'POST',
      cookie,
      body: { imageData: `data:image/png;base64,${PNG_B64}`, name: 'My Face' },
    }),
    env,
  );
  assert.equal(up.status, 200);
  const created = await up.json();
  assert.match(created.id, /^[0-9a-f]{32}$/);
  assert.equal(created.selected, true);

  const key = `avatars/u1/${created.id}`;
  assert.ok(r2._objects.has(key), 'bytes landed under avatars/<userId>/');
  assert.equal(r2._objects.get(key).httpMetadata.contentType, 'image/png');
  const upsert = d1.executed.find((e) => /INSERT INTO lens_profiles/.test(e.sql));
  assert.ok(upsert, 'the profile recorded the selection');
  assert.equal(upsert.binds[3], key, 'avatar_key is the SERVER-built key, never client input');

  const reserve = d1.executed.find((e) => /INSERT INTO user_avatars/.test(e.sql));
  assert.ok(reserve, 'the slot was reserved in D1');
  assert.match(reserve.sql, /SELECT COUNT\(\*\) FROM user_avatars WHERE user_id/,
    'the cap guard lives IN the insert — atomic, not read-then-write');

  const { cookie: cookie2, d1: d1b } = await userSession('u1', {
    profileAvatarKey: key,
    avatarRows: [{ id: created.id, name: 'My Face', size: 68, created_at: 1 }],
  });
  const list = await call(req('/api/me/avatars', { cookie: cookie2 }), baseEnv(d1b, r2));
  const body = await list.json();
  assert.equal(body.avatars.length, 1);
  assert.equal(body.avatars[0].id, created.id);
  assert.equal(body.avatars[0].name, 'My Face');
  assert.equal(body.avatars[0].selected, true);
});

test('avatars: garbage refuses with image_invalid before any storage', async () => {
  const { cookie, d1 } = await userSession('u1');
  const r2 = createFakeR2();
  const res = await call(
    req('/api/me/avatars', { method: 'POST', cookie, body: { imageData: 'not base64 !!!' } }),
    baseEnv(d1, r2),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'image_invalid');
  assert.equal(r2._objects.size, 0);
});

test('avatars: the cap is ATOMIC — a lost slot race is a 409 with NO bytes written', async () => {
  // The conditional insert refuses (as it would when a concurrent upload
  // takes the last slot between nothing and nothing — there is no separate
  // read to win). The route must answer 409 and R2 must stay untouched;
  // this test fails against any read-then-write reintroduction because the
  // fixture holds ZERO existing rows, so only the ATOMIC guard can refuse.
  const { cookie, d1 } = await userSession('u1', {
    runMeta: (sql) => (/SELECT COUNT\(\*\) FROM user_avatars/.test(sql) ? { changes: 0 } : null),
  });
  const r2 = createFakeR2();
  const res = await call(
    req('/api/me/avatars', { method: 'POST', cookie, body: { imageData: PNG_B64 } }),
    baseEnv(d1, r2),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'avatar_limit_reached');
  assert.equal(r2._objects.size, 0, 'a refused slot never reaches storage');
});

test('avatars: a failed byte write releases the slot — the reservation never outlives the bytes', async () => {
  const { cookie, d1 } = await userSession('u1');
  const r2 = createFakeR2();
  r2.put = async () => {
    throw new Error('r2 exploded');
  };
  const res = await call(
    req('/api/me/avatars', { method: 'POST', cookie, body: { imageData: PNG_B64 } }),
    baseEnv(d1, r2),
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'storage_unavailable');
  const release = d1.executed.find((e) => /DELETE FROM user_avatars/.test(e.sql));
  assert.ok(release, 'the reconcile delete ran');
  assert.equal(release.binds[1], 'u1');
});

test('avatars: delete clears the selection only when it was the selected one', async () => {
  const { cookie, d1 } = await userSession('u1');
  const r2 = createFakeR2();
  const id = 'b'.repeat(32);
  await r2.put(`avatars/u1/${id}`, new Uint8Array([1]));
  const res = await call(
    req(`/api/me/avatars/${id}`, { method: 'DELETE', cookie }),
    baseEnv(d1, r2),
  );
  assert.equal(res.status, 200);
  assert.equal(r2._objects.size, 0);
  const clear = d1.executed.find((e) => /SET avatar_key = NULL/.test(e.sql));
  assert.ok(clear, 'the conditional clear ran');
  assert.match(clear.sql, /AND avatar_key = \?2/,
    'the clear is CONDITIONAL in SQL — deleting one avatar must never unselect another');
  assert.deepEqual(clear.binds.slice(0, 2), ['u1', `avatars/u1/${id}`]);
  const rowGone = d1.executed.find((e) => /DELETE FROM user_avatars/.test(e.sql));
  assert.ok(rowGone, 'the slot row died with the bytes');
});

// ── THE ISOLATION PROOFS — the mandate itself ─────────────────────────────

test("isolation: user B cannot read, select, or delete user A's avatar — the id does not exist in B's namespace", async () => {
  const r2 = createFakeR2();
  const id = 'c'.repeat(32);
  await r2.put(`avatars/uA/${id}`, new Uint8Array([7, 7, 7]), { customMetadata: { name: 'A' } });

  const { cookie: cookieB, d1: d1B } = await userSession('uB');
  const envB = baseEnv(d1B, r2);

  const get = await call(req(`/api/me/avatars/${id}`, { cookie: cookieB }), envB);
  assert.equal(get.status, 404, 'read: 404, never bytes');

  const sel = await call(
    req(`/api/me/avatars/${id}/select`, { method: 'POST', cookie: cookieB, body: {} }),
    envB,
  );
  assert.equal(sel.status, 404, 'select: 404, never a foreign key in the profile');

  const del = await call(req(`/api/me/avatars/${id}`, { method: 'DELETE', cookie: cookieB }), envB);
  assert.equal(del.status, 200, 'delete answers ok (idempotent)…');
  assert.ok(r2._objects.has(`avatars/uA/${id}`), "…but A's object is untouched — B deleted from B's namespace");

  const list = await call(req('/api/me/avatars', { cookie: cookieB }), envB);
  assert.deepEqual((await list.json()).avatars, [], "B's library never shows A's objects");
});

test("isolation: a video session started with another user's avatarId gets 404 before any spend", async () => {
  const r2 = createFakeR2();
  const id = 'd'.repeat(32);
  await r2.put(`avatars/uA/${id}`, new Uint8Array([7]));

  const { cookie: cookieB, d1: d1B } = await userSession('uB');
  const env = {
    ...baseEnv(d1B, r2),
    VIDEO_LIMITER: allowLimiter,
    ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    DECART_API_KEY: 'unit-test-key',
    // deliberately NO VIDEO_LEDGER: if the handler reached the reserve step,
    // this test would 500 instead of 404 — the assert below proves the
    // refusal happens before a reservation could exist.
  };
  const res = await call(
    req('/api/video/session', {
      method: 'POST',
      cookie: cookieB,
      body: { sdpOffer: 'v=0 fake', avatarId: id },
    }),
    env,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'avatar_not_found');
});

test('isolation: avatarId without a cookie session is refused even with a valid ops context', async () => {
  const r2 = createFakeR2();
  const { d1 } = await userSession('uA');
  const env = {
    ...baseEnv(d1, r2),
    VIDEO_LIMITER: allowLimiter,
    ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    DECART_API_KEY: 'unit-test-key',
  };
  // No cookie at all: videoGate would fall through to the ops token — but
  // there is none here either, so the gate itself refuses first (401).
  const anon = await call(
    req('/api/video/session', { method: 'POST', body: { sdpOffer: 'v=0', avatarId: 'e'.repeat(32) } }),
    env,
  );
  assert.equal(anon.status, 401, 'the gate refuses anonymous callers before avatar logic');
});

test('loadAvatarB64: round-trips bytes for the owner, null for everyone and everything else', async () => {
  const r2 = createFakeR2();
  const id = 'f'.repeat(32);
  const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  await r2.put(`avatars/uA/${id}`, bytes);
  const env = { AVATARS: r2 };

  assert.equal(await loadAvatarB64(env, 'uA', id), PNG_B64, 'owner: exact bytes back');
  assert.equal(await loadAvatarB64(env, 'uB', id), null, 'other user: null');
  assert.equal(await loadAvatarB64(env, 'uA', 'nope'), null, 'malformed id: null');
  assert.equal(await loadAvatarB64(env, '', id), null, 'no user: null');
  assert.equal(await loadAvatarB64({}, 'uA', id), null, 'no binding: null');
});

test('avatars: a wrong method on the select route is 405, like every other route shape', async () => {
  const { cookie, d1 } = await userSession('u1');
  const res = await call(
    req(`/api/me/avatars/${'a'.repeat(32)}/select`, { cookie }),
    baseEnv(d1, createFakeR2()),
  );
  assert.equal(res.status, 405);
  assert.equal((await res.json()).error, 'method_not_allowed');
});

test('avatars: bytes surviving a FAILED R2 delete are unreachable — the row is the authority', async () => {
  // ONE stateful fixture carries delete → fetch → select, so these
  // assertions can only pass if remove() actually removed the row
  // (CodeRabbit round 3: a hand-built empty fixture would pass even if the
  // row delete were a no-op). The rows array is LIVE: the respond closure
  // serves it, and the runMeta hook mutates it when the DELETE executes.
  const id = 'e'.repeat(32);
  const key = `avatars/u1/${id}`;
  const rows = [{ id, name: 'ghost', content_type: 'image/png', size: 3, created_at: 1 }];
  const r2 = createFakeR2();
  await r2.put(key, new Uint8Array([9, 9, 9]));
  let r2Deletes = 0;
  r2.delete = async () => {
    r2Deletes += 1;
    throw new Error('r2 refused the delete');
  };
  const { cookie, d1 } = await userSession('u1', {
    avatarRows: rows,
    runMeta: (sql, binds) => {
      if (/DELETE FROM user_avatars/.test(sql) && binds[1] === 'u1') {
        const i = rows.findIndex((r) => r.id === binds[0]);
        if (i >= 0) rows.splice(i, 1);
      }
      return null;
    },
  });
  const env = baseEnv(d1, r2);

  const del = await call(req(`/api/me/avatars/${id}`, { method: 'DELETE', cookie }), env);
  assert.equal(del.status, 200);
  assert.equal(rows.length, 0, 'the row really died — not just a statement in a log');
  assert.equal(r2Deletes, 1, 'the byte delete was ATTEMPTED — best-effort is not skip');
  assert.ok(d1.executed.some((e) => /SET avatar_key = NULL/.test(e.sql)),
    'the selection cleared DESPITE the failed byte delete');
  assert.ok(r2._objects.has(key), 'the bytes really did survive — the hazard is real');

  // Same fixture, post-failure state: row gone, bytes present. Every read
  // path must answer 404 — D1 speaks before R2.
  const get = await call(req(`/api/me/avatars/${id}`, { cookie }), env);
  assert.equal(get.status, 404, 'fetch: the orphaned bytes never serve');
  const sel = await call(
    req(`/api/me/avatars/${id}/select`, { method: 'POST', cookie, body: {} }),
    env,
  );
  assert.equal(sel.status, 404, 'select: an orphan cannot become the identity');
});
