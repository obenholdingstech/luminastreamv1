// Run: node --test — the auth endpoints, driven through the Worker's default
// export exactly like http.test.js: fake env, injectable limiters, and a
// fake D1 whose responder serves REAL hashes computed by the same KDF.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { SESSION_COOKIE, hashPassword, newSessionToken, sessionTokenHash } from '../src/auth.js';

const STUDIO = 'https://studio.luminastream.live';
const allowLimiter = { async limit() { return { success: true }; } };
const denyLimiter = { async limit() { return { success: false }; } };

const baseEnv = (d1, { limiter = allowLimiter } = {}) => ({
  IDENTITY_DB: d1,
  AUTH_LIMITER: limiter,
});

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

// ── signup ────────────────────────────────────────────────────────────────

test('signup: a valid request creates user+identity atomically and answers with the session cookie', async () => {
  const d1 = createFakeD1();
  const res = await call(
    req('/api/auth/signup', {
      method: 'POST',
      body: { email: ' CEO@Example.com ', password: 'a-long-enough-password', displayName: 'Amy' },
    }),
    baseEnv(d1),
  );
  assert.equal(res.status, 200);
  const cookie = res.headers.get('Set-Cookie');
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
  assert.match(cookie, /HttpOnly/);
  const batched = d1.executed.filter((e) => e.via === 'batch');
  assert.equal(batched.length, 2, 'user + identity in one batch');
  assert.equal(batched[1].binds[3], 'ceo@example.com', 'email stored normalized');
  assert.match(batched[1].binds[4], /^pbkdf2-sha384\$v1\$/, 'a real KDF hash, never plaintext');
  const sessionInsert = d1.executed.find((e) => /INSERT INTO auth_sessions/.test(e.sql));
  assert.ok(sessionInsert, 'a session row was written');
  assert.equal(sessionInsert.binds[0].length, 43, 'the row stores a HASH, not the token');
  assert.ok(!cookie.includes(sessionInsert.binds[0]), 'cookie token ≠ stored hash');
});

test('signup: validation refuses before any database work', async () => {
  for (const [body, error] of [
    [{ email: 'nope', password: 'a-long-enough-password' }, 'email_invalid'],
    [{ email: 'a@b.co', password: 'short' }, 'password_too_short'],
  ]) {
    const d1 = createFakeD1();
    const res = await call(req('/api/auth/signup', { method: 'POST', body }), baseEnv(d1));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, error);
    assert.equal(d1.executed.length, 0, 'the database never heard about it');
  }
});

test('signup: a duplicate email is a 409, not a 500', async () => {
  const d1 = createFakeD1();
  d1.batch = async () => {
    throw new Error('D1_ERROR: UNIQUE constraint failed: auth_identities.provider, auth_identities.subject');
  };
  const res = await call(
    req('/api/auth/signup', { method: 'POST', body: { email: 'a@b.co', password: 'a-long-enough-password' } }),
    baseEnv(d1),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'email_in_use');
});

test('signup fails CLOSED: a missing limiter is 503, a deny is 429, a foreign Origin is 403', async () => {
  const body = { email: 'a@b.co', password: 'a-long-enough-password' };
  const noLimiter = await call(
    req('/api/auth/signup', { method: 'POST', body }),
    { IDENTITY_DB: createFakeD1() },
  );
  assert.equal(noLimiter.status, 503, 'no limiter binding ⇒ refuse, never fail open');
  const denied = await call(
    req('/api/auth/signup', { method: 'POST', body }),
    baseEnv(createFakeD1(), { limiter: denyLimiter }),
  );
  assert.equal(denied.status, 429);
  const foreign = await call(
    req('/api/auth/signup', { method: 'POST', body, origin: 'https://evil.example' }),
    baseEnv(createFakeD1()),
  );
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_not_allowed');
});

// ── signin ────────────────────────────────────────────────────────────────

const seededDb = async (password) => {
  const stored = await hashPassword(password, { iterations: 1000 });
  return createFakeD1({
    respond: (sql) =>
      /FROM auth_identities/.test(sql) ? { user_id: 'u1', password_hash: stored, verified: 0 } : null,
  });
};

test('signin: the right password answers a session cookie', async () => {
  const d1 = await seededDb('a-long-enough-password');
  const res = await call(
    req('/api/auth/signin', { method: 'POST', body: { email: 'a@b.co', password: 'a-long-enough-password' } }),
    baseEnv(d1),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), new RegExp(`^${SESSION_COOKIE}=`));
});

test('signin: wrong password and unknown account are the SAME answer, and no session is created', async () => {
  const wrong = await call(
    req('/api/auth/signin', { method: 'POST', body: { email: 'a@b.co', password: 'not-the-password!' } }),
    baseEnv(await seededDb('a-long-enough-password')),
  );
  const unknownD1 = createFakeD1({ respond: () => null });
  const unknown = await call(
    req('/api/auth/signin', { method: 'POST', body: { email: 'ghost@b.co', password: 'whatever-here-x' } }),
    baseEnv(unknownD1),
  );
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json(), 'uniform words — no enumeration');
  assert.ok(
    !unknownD1.executed.some((e) => /INSERT INTO auth_sessions/.test(e.sql)),
    'no session for a failed sign-in',
  );
});

test('signin burns BOTH limiter keys — per-IP and per-account', async () => {
  const keys = [];
  const recordingLimiter = { async limit({ key }) { keys.push(key); return { success: true }; } };
  await call(
    req('/api/auth/signin', { method: 'POST', body: { email: 'a@b.co', password: 'a-long-enough-password' } }),
    baseEnv(await seededDb('a-long-enough-password'), { limiter: recordingLimiter }),
  );
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^signin:ip:/);
  assert.match(keys[1], /^signin:sub:/);
});

test('signin: a below-standard stored hash is rehashed on success — the fleet strengthens without a reset', async () => {
  const d1 = await seededDb('a-long-enough-password'); // seeded at 1000 iterations
  await call(
    req('/api/auth/signin', { method: 'POST', body: { email: 'a@b.co', password: 'a-long-enough-password' } }),
    baseEnv(d1),
  );
  const rehash = d1.executed.find((e) => /UPDATE auth_identities SET password_hash/.test(e.sql));
  assert.ok(rehash, 'the rehash write happened');
  assert.match(rehash.binds[2], /\$100000\$/, 'at the CURRENT iteration standard');
});

// ── session-bearing routes ───────────────────────────────────────────────

const sessionEnv = async () => {
  const token = newSessionToken();
  const tokenHash = await sessionTokenHash(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const d1 = createFakeD1({
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql) && binds[0] === tokenHash) {
        return { user_id: 'u1', last_seen_at: nowSec, display_name: 'Amy' };
      }
      if (/FROM lens_profiles/.test(sql)) {
        return { voice_id: 'v1', voice_name: 'Cloned', style_prompt: null, video_path_ms: 700, avatar_key: 'k' };
      }
      return null;
    },
  });
  return { token, d1, env: baseEnv(d1) };
};

test('me: no cookie is 401; a live session answers user + profile (avatar as a FLAG, never the key)', async () => {
  const { token, env } = await sessionEnv();
  const anonymous = await call(req('/api/auth/me'), env);
  assert.equal(anonymous.status, 401);
  const res = await call(req('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.id, 'u1');
  assert.equal(body.profile.voiceId, 'v1');
  assert.equal(body.profile.hasAvatar, true);
  assert.equal(body.profile.avatarKey, undefined, 'storage keys are server business');
});

test('putProfile: session-gated, clamped, and avatar_key is not client-writable', async () => {
  const { token, d1, env } = await sessionEnv();
  const anonymous = await call(
    req('/api/me/profile', { method: 'PUT', body: { voiceId: 'v2' } }),
    env,
  );
  assert.equal(anonymous.status, 401);
  const res = await call(
    req('/api/me/profile', {
      method: 'PUT',
      cookie: `${SESSION_COOKIE}=${token}`,
      body: { voiceId: 'v2', videoPathMs: 99999, avatarKey: 'someone-elses-key' },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const upsert = d1.executed.find((e) => /INSERT INTO lens_profiles/.test(e.sql));
  assert.ok(upsert, 'profile written');
  assert.equal(upsert.binds[1], 'v2');
  assert.equal(upsert.binds[3], null, 'client-supplied avatarKey ignored');
  assert.equal(upsert.binds[5], null, 'out-of-range videoPathMs dropped, not stored');
});

test('signout deletes the session row and clears the cookie — idempotently', async () => {
  const { token, d1, env } = await sessionEnv();
  const res = await call(
    req('/api/auth/signout', { method: 'POST', cookie: `${SESSION_COOKIE}=${token}` }),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.ok(d1.executed.some((e) => /DELETE FROM auth_sessions WHERE token_hash/.test(e.sql)));
  const bare = await call(req('/api/auth/signout', { method: 'POST' }), baseEnv(createFakeD1()));
  assert.equal(bare.status, 200, 'signing out signed-out is success');
  assert.match(bare.headers.get('Set-Cookie'), /Max-Age=0/);
});
