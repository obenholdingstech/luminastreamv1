// Run: node --test — P4c's Worker half: the voice policy is STAMPED into the
// LiveKit grant at session create (signed, so the client cannot edit it),
// and /api/me/voices answers only from the caller's own rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { mintLiveKitToken } from '../src/livekit.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const allowLimiter = { async limit() { return { success: true }; } };

function req(path, { method = 'POST', origin = 'https://studio.luminastream.live', body, cookie } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function decodeJwtPayload(token) {
  const b64 = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/** A registry stub that always grants one slot. */
const grantingRegistry = {
  idFromName: () => 'registry',
  get: () => ({
    fetch: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          endToken: 'end-token',
          session: {
            id: 'sess-1',
            room: 'luminastream-test',
            identity: 'user-identity-1',
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  }),
};

async function signedInEnv({ role = 'user', voices = [] } = {}) {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql) && binds[0] === tokenHash) {
        return {
          user_id: 'u1',
          last_seen_at: Math.floor(Date.now() / 1000),
          display_name: 'someone',
          role,
          verified: 1,
        };
      }
      if (/FROM user_voices/.test(sql) && binds[0] === 'u1') {
        return voices.map((v) => ({ id: `row-${v}`, vendor_voice_id: v, label: v, created_at: 1 }));
      }
      return null;
    },
  });
  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    env: {
      IDENTITY_DB: d1,
      SESSION_REGISTRY: grantingRegistry,
      SESSION_LIMITER: allowLimiter,
      TOKEN_LIMITER: allowLimiter,
      ADMIN_SESSION_SECRET: 'unit-test-session-secret',
      LIVEKIT_API_KEY: 'lk-key',
      LIVEKIT_API_SECRET: 'lk-secret',
    },
  };
}

// ── the stamp ─────────────────────────────────────────────────────────────

test("session create: an ordinary user's grant carries voicePolicy 'own' with exactly their clone ids", async () => {
  const { cookie, env } = await signedInEnv({ voices: ['clone-a', 'clone-b'] });
  const res = await worker.fetch(req('/api/session/create', { cookie }), env);
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const payload = decodeJwtPayload(token);
  assert.deepEqual(JSON.parse(payload.metadata), {
    voicePolicy: 'own',
    voices: ['clone-a', 'clone-b'],
  });
});

test("session create: an admin's grant carries voicePolicy 'all'", async () => {
  const { cookie, env } = await signedInEnv({ role: 'admin' });
  const res = await worker.fetch(req('/api/session/create', { cookie }), env);
  assert.equal(res.status, 200);
  const payload = decodeJwtPayload((await res.json()).token);
  assert.deepEqual(JSON.parse(payload.metadata), { voicePolicy: 'all' });
});

test('mintLiveKitToken: the metadata claim rides the signature; absent stays absent', async () => {
  const env = { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
  const withMeta = await mintLiveKitToken(env, {
    room: 'r',
    identity: 'i',
    metadata: '{"voicePolicy":"all"}',
  });
  assert.equal(decodeJwtPayload(withMeta.token).metadata, '{"voicePolicy":"all"}');
  const without = await mintLiveKitToken(env, { room: 'r', identity: 'i' });
  assert.equal(decodeJwtPayload(without.token).metadata, undefined, 'no claim invented');
});

// ── the listing ───────────────────────────────────────────────────────────

test('/api/me/voices: the caller sees exactly their rows; anonymous sees a 401', async () => {
  const { cookie, env } = await signedInEnv({ voices: ['clone-a'] });
  const res = await worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.voices, [{ id: 'row-clone-a', voiceId: 'clone-a', label: 'clone-a' }]);

  const anon = await worker.fetch(req('/api/me/voices', { method: 'GET' }), env);
  assert.equal(anon.status, 401);
});

test('/api/me/voices: the query binds the SESSION user id — there is no parameter that could name anyone else', async () => {
  const { cookie, env } = await signedInEnv({ voices: [] });
  await worker.fetch(req('/api/me/voices?userId=u2&user=evil', { method: 'GET', cookie }), env);
  const q = env.IDENTITY_DB.executed.find((e) => /FROM user_voices/.test(e.sql));
  assert.ok(q, 'the voices query ran');
  assert.equal(q.binds[0], 'u1', 'bound to the cookie session, query string ignored');
});
