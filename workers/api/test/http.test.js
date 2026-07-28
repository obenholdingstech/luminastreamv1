// Run: node --test workers/api/test/http.test.js
//
// End-to-end HTTP behavior driven through the Worker's default export with a
// fake `env` (secrets + injectable rate limiters). Covers routing, the admin
// gate, the mint gate, the CORS matrix, and rate-limit trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { VERSION } from '../src/index.js';

const ADMIN_PASSWORD = 'correct horse battery staple';
const STUDIO = 'https://studio.luminastream.live';

const BASE_ENV = {
  ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET: 'unit-test-session-secret',
  LIVEKIT_API_KEY: 'APIkey',
  LIVEKIT_API_SECRET: 'secretsecretsecret',
  LIVEKIT_URL: 'wss://proj.livekit.cloud',
};

const allowLimiter = { async limit() { return { success: true }; } };
const denyLimiter = { async limit() { return { success: false }; } };
function countingLimiter(max) {
  let n = 0;
  return {
    async limit() {
      n += 1;
      return { success: n <= max };
    },
  };
}

function req(path, { method = 'GET', origin, token, body, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.luminastream.live${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const call = (request, env = BASE_ENV) => worker.fetch(request, env);

async function mintSession(env = BASE_ENV) {
  const res = await call(
    req('/api/admin/verify', { method: 'POST', origin: STUDIO, body: { password: ADMIN_PASSWORD } }),
    { ...env, VERIFY_LIMITER: allowLimiter },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.token);
  return body.token;
}

test('GET /api/health → 200 { ok, version }', async () => {
  const res = await call(req('/api/health'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: VERSION });
});

test('unknown path → 404; wrong method → 405', async () => {
  assert.equal((await call(req('/api/nope'))).status, 404);
  assert.equal((await call(req('/api/admin/verify'))).status, 405);
  assert.equal((await call(req('/api/livekit/token'))).status, 405);
  assert.equal((await call(req('/api/health', { method: 'POST' }))).status, 405);
});

test('verify: wrong password → 401, correct → 200 with token', async () => {
  const bad = await call(req('/api/admin/verify', { method: 'POST', body: { password: 'nope' } }));
  assert.equal(bad.status, 401);
  const token = await mintSession();
  assert.equal(typeof token, 'string');
});

test('verify: missing/blank password → 400', async () => {
  assert.equal((await call(req('/api/admin/verify', { method: 'POST', body: {} }))).status, 400);
  assert.equal((await call(req('/api/admin/verify', { method: 'POST', body: { password: '' } }))).status, 400);
});

test('token: valid session mints a 3-part LiveKit token + returns url', async () => {
  const token = await mintSession();
  const res = await call(
    req('/api/livekit/token', { method: 'POST', origin: STUDIO, token, body: { room: 'r1', identity: 'u1' } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.token.split('.').length, 3);
  assert.equal(body.url, 'wss://proj.livekit.cloud');
  assert.equal(body.room, 'r1');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), STUDIO);
});

test('token: absent / garbage / tampered X-Admin-Token → 401', async () => {
  assert.equal(
    (await call(req('/api/livekit/token', { method: 'POST', body: { room: 'r', identity: 'u' } }))).status,
    401,
  );
  assert.equal(
    (await call(req('/api/livekit/token', { method: 'POST', token: 'garbage.token', body: { room: 'r', identity: 'u' } }))).status,
    401,
  );
  const token = await mintSession();
  const tampered = `${token.slice(0, -3)}AAA`;
  assert.equal(
    (await call(req('/api/livekit/token', { method: 'POST', token: tampered, body: { room: 'r', identity: 'u' } }))).status,
    401,
  );
});

test('token: valid session but missing room/identity → 400', async () => {
  const token = await mintSession();
  assert.equal(
    (await call(req('/api/livekit/token', { method: 'POST', token, body: { room: 'r' } }))).status,
    400,
  );
});

test('CORS preflight: allowed origins → 204 + ACAO; disallowed → 403 + no ACAO', async () => {
  const allowed = [
    STUDIO,
    'http://localhost:5173',
    'https://luminastream-studio.pages.dev',
    'https://abc123.luminastream-studio.pages.dev',
    'https://feat-x.luminastream-studio.pages.dev',
  ];
  for (const origin of allowed) {
    const res = await call(req('/api/admin/verify', { method: 'OPTIONS', origin }));
    assert.equal(res.status, 204, origin);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin, origin);
    assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-Admin-Token/);
    assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
  }

  const disallowed = [
    'https://evil.com',
    'https://evil.pages.dev', // some other Pages site
    'http://studio.luminastream.live', // wrong scheme
    'https://studio.luminastream.live.evil.com', // suffix-spoof
    'https://notluminastream-studio.pages.dev', // missing dot boundary
    'http://localhost:3000', // wrong dev port
  ];
  for (const origin of disallowed) {
    const res = await call(req('/api/admin/verify', { method: 'OPTIONS', origin }));
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, origin);
  }
});

test('CORS: response ACAO present only for allowed origins', async () => {
  assert.equal(
    (await call(req('/api/health', { origin: STUDIO }))).headers.get('Access-Control-Allow-Origin'),
    STUDIO,
  );
  assert.equal(
    (await call(req('/api/health', { origin: 'https://evil.com' }))).headers.get('Access-Control-Allow-Origin'),
    null,
  );
  assert.equal(
    (await call(req('/api/health'))).headers.get('Access-Control-Allow-Origin'),
    null,
  );
});

test('rate limit: verify trips → 429 even with the correct password', async () => {
  const res = await call(
    req('/api/admin/verify', { method: 'POST', body: { password: ADMIN_PASSWORD } }),
    { ...BASE_ENV, VERIFY_LIMITER: denyLimiter },
  );
  assert.equal(res.status, 429);
});

test('rate limit: verify allows N then blocks (counting limiter)', async () => {
  const env = { ...BASE_ENV, VERIFY_LIMITER: countingLimiter(2) };
  const hit = () => call(req('/api/admin/verify', { method: 'POST', body: { password: 'whatever' } }), env);
  assert.equal((await hit()).status, 401); // under limit → reaches (failed) password check
  assert.equal((await hit()).status, 401);
  assert.equal((await hit()).status, 429); // limiter trips on the 3rd
});

test('rate limit: token endpoint trips → 429 for a valid session', async () => {
  const token = await mintSession();
  const res = await call(
    req('/api/livekit/token', { method: 'POST', token, body: { room: 'r', identity: 'u' } }),
    { ...BASE_ENV, TOKEN_LIMITER: denyLimiter },
  );
  assert.equal(res.status, 429);
});

test('rate limit: token endpoint throttles anonymous spam BEFORE verifying (429, not 401)', async () => {
  // garbage token + deny limiter → the limiter must trip before the HMAC
  // verify, so the crypto path is never reachable by unauthenticated flooders
  const res = await call(
    req('/api/livekit/token', { method: 'POST', token: 'garbage.token', body: { room: 'r', identity: 'u' } }),
    { ...BASE_ENV, TOKEN_LIMITER: denyLimiter },
  );
  assert.equal(res.status, 429);
});

test('misconfigured server (no secrets) → 500', async () => {
  assert.equal((await call(req('/api/admin/verify', { method: 'POST', body: { password: 'x' } }), {})).status, 500);
});
