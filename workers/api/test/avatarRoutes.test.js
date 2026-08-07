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
async function userSession(userId, { profileAvatarKey = null } = {}) {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
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

  const { cookie: cookie2, d1: d1b } = await userSession('u1', { profileAvatarKey: key });
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

test('avatars: the per-user cap refuses the ninth', async () => {
  const { cookie, d1 } = await userSession('u1');
  const r2 = createFakeR2();
  for (let i = 0; i < 8; i += 1) {
    await r2.put(`avatars/u1/${String(i).repeat(32).slice(0, 32)}`, new Uint8Array([1]));
  }
  const res = await call(
    req('/api/me/avatars', { method: 'POST', cookie, body: { imageData: PNG_B64 } }),
    baseEnv(d1, r2),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'avatar_limit_reached');
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
  assert.deepEqual(clear.binds.slice(0, 2), ['u1', `avatars/u1/${id}`]);
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
