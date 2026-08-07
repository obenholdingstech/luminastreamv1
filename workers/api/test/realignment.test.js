// Run: node --test — the realignment (7 Aug 2026): identity carries
// authority. The session gate's two doors, the verification wall between
// them, and the ADMIN_EMAILS bootstrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const STUDIO = 'https://studio.luminastream.live';
const allowLimiter = { async limit() { return { success: true }; } };

const call = (request, env) => worker.fetch(request, env);

function req(path, { method = 'POST', origin = STUDIO, cookie, token, body } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const userEnv = async ({ role = 'user', verified = 0 } = {}) => {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql) && binds[0] === tokenHash) {
        return {
          user_id: 'u1',
          last_seen_at: Math.floor(Date.now() / 1000),
          display_name: 'Amy',
          role,
          verified,
        };
      }
      return null;
    },
  });
  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    d1,
    env: {
      IDENTITY_DB: d1,
      AUTH_LIMITER: allowLimiter,
      SESSION_LIMITER: allowLimiter,
      ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    },
  };
};

test('an ADMIN user session passes the session gate — no admin token anywhere', async () => {
  const { cookie, env } = await userEnv({ role: 'admin' });
  const res = await call(req('/api/session/create', { cookie }), env);
  const body = await res.json();
  // The gate passed; the refusal (if any) is the REGISTRY's absence in this
  // fake env — never an auth refusal.
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
  assert.notEqual(body.error, 'unauthorized');
});

test('a VERIFIED ordinary user passes the gate too — verification is the wall, not role', async () => {
  const { cookie, env } = await userEnv({ role: 'user', verified: 1 });
  const res = await call(req('/api/session/create', { cookie }), env);
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});

test('signed-in but UNVERIFIED is its own refusal — the UI must say "verify", never "sign in"', async () => {
  const { cookie, env } = await userEnv({ role: 'user', verified: 0 });
  const res = await call(req('/api/session/create', { cookie }), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'verification_required');
});

test('no cookie and no admin token is a plain 401 — nothing about the account model leaks', async () => {
  const { env } = await userEnv();
  const res = await call(req('/api/session/create', {}), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('the ADMIN_EMAILS bootstrap promotes on sign-up; an unlisted email stays a user', async () => {
  for (const [email, expectPromotion] of [
    ['ceo@luminastream.live', true],
    ['stranger@example.com', false],
  ]) {
    const d1 = createFakeD1();
    const env = {
      IDENTITY_DB: d1,
      AUTH_LIMITER: allowLimiter,
      ADMIN_EMAILS: 'CEO@luminastream.live , other@x.co',
    };
    const res = await call(
      req('/api/auth/signup', { body: { email, password: 'a-long-enough-password' } }),
      env,
    );
    assert.equal(res.status, 200);
    const promotion = d1.executed.find((e) => /UPDATE users SET role/.test(e.sql));
    if (expectPromotion) {
      assert.ok(promotion, `${email} must be promoted (allowlist matches case-insensitively)`);
      assert.equal(promotion.binds[1], 'admin');
    } else {
      assert.equal(promotion, undefined, `${email} must NOT be promoted`);
    }
  }
});

test('an EMPTY or absent ADMIN_EMAILS grants nobody — both spellings of "nobody"', async () => {
  for (const env of [
    { IDENTITY_DB: createFakeD1(), AUTH_LIMITER: allowLimiter },
    { IDENTITY_DB: createFakeD1(), AUTH_LIMITER: allowLimiter, ADMIN_EMAILS: '' },
  ]) {
    await call(
      req('/api/auth/signup', { body: { email: 'a@b.co', password: 'a-long-enough-password' } }),
      env,
    );
    assert.equal(
      env.IDENTITY_DB.executed.find((e) => /UPDATE users SET role/.test(e.sql)),
      undefined,
      `granted nobody with ADMIN_EMAILS=${JSON.stringify(env.ADMIN_EMAILS)}`,
    );
  }
});

test('REVOCATION: an admin whose email left the allowlist is demoted at next sign-in', async () => {
  const { hashPassword } = await import('../src/auth.js');
  const stored = await hashPassword('a-long-enough-password', { iterations: 1000 });
  const d1 = createFakeD1({
    respond: (sql) =>
      /FROM auth_identities/.test(sql)
        ? { user_id: 'u1', password_hash: stored, verified: 1, role: 'admin' }
        : null,
  });
  const env = { IDENTITY_DB: d1, AUTH_LIMITER: allowLimiter, ADMIN_EMAILS: 'someone-else@x.co' };
  const res = await call(
    req('/api/auth/signin', { body: { email: 'ex-admin@x.co', password: 'a-long-enough-password' } }),
    env,
  );
  assert.equal(res.status, 200, 'the sign-in itself succeeds — authority changes, access does not');
  const demotion = d1.executed.find((e) => /UPDATE users SET role/.test(e.sql));
  assert.ok(demotion, 'the demotion write happened');
  assert.equal(demotion.binds[1], 'user');
});

test('no role write on the COMMON case — a listed admin signing in again writes nothing', async () => {
  const { hashPassword } = await import('../src/auth.js');
  const stored = await hashPassword('a-long-enough-password', { iterations: 100_000 });
  const d1 = createFakeD1({
    respond: (sql) =>
      /FROM auth_identities/.test(sql)
        ? { user_id: 'u1', password_hash: stored, verified: 1, role: 'admin' }
        : null,
  });
  const env = { IDENTITY_DB: d1, AUTH_LIMITER: allowLimiter, ADMIN_EMAILS: 'ceo@x.co' };
  await call(
    req('/api/auth/signin', { body: { email: 'ceo@x.co', password: 'a-long-enough-password' } }),
    env,
  );
  assert.equal(
    d1.executed.find((e) => /UPDATE users SET role/.test(e.sql)),
    undefined,
    'already-correct roles cost zero writes per sign-in',
  );
});

test('me() exposes role and verified — the UI routes on them (studio gate, admin chrome)', async () => {
  const { cookie, env } = await userEnv({ role: 'admin', verified: 1 });
  const res = await call(req('/api/auth/me', { method: 'GET', cookie }), env);
  const body = await res.json();
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.verified, true);
});
