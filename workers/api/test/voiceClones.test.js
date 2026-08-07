// Run: node --test — P4c-3: clone creation/deletion. The wall order is the
// test order: limiter → session → verification → vendor key (FAIL-CLOSED
// until the CEO places it) → cap → sample. The vendor stub follows the
// whitelabel lesson: it speaks ElevenLabs' own wire shapes (voice_id,
// xi-api-key) so green tests can't ship a Worker whose first real call 400s.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const allowLimiter = { async limit() { return { success: true }; } };
const SAMPLE_B64 = Buffer.from('fake-audio-bytes-long-enough-to-matter').toString('base64');

function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7', Origin: 'https://studio.luminastream.live' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** ElevenLabs stub speaking the vendor's real shapes. */
function stubVendor({ addStatus = 200, deleteStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.elevenlabs.io')) return original(url, opts);
    calls.push({ url: u, method: opts.method ?? 'GET', headers: opts.headers ?? {} });
    if (u.endsWith('/v1/voices/add')) {
      return new Response(
        JSON.stringify(addStatus === 200 ? { voice_id: 'v-created' } : { detail: 'nope' }),
        { status: addStatus, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (/\/v1\/voices\//.test(u)) {
      return new Response(JSON.stringify({}), { status: deleteStatus, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function userEnv({ verified = 1, voices = [], hasKey = true, runMeta } = {}) {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
    runMeta,
    respond: (sql, binds) => {
      if (/FROM auth_sessions/.test(sql) && binds[0] === tokenHash) {
        return {
          user_id: 'u1',
          last_seen_at: Math.floor(Date.now() / 1000),
          display_name: 'someone',
          role: 'user',
          verified,
        };
      }
      if (/SELECT id, vendor_voice_id, label FROM user_voices/.test(sql)) {
        const [id, userId] = binds;
        const hit = voices.find((v) => v.rowId === id && userId === 'u1');
        return hit ? { id: hit.rowId, vendor_voice_id: hit.vendorId, label: hit.label ?? 'x' } : null;
      }
      if (/FROM user_voices WHERE user_id/.test(sql) && binds[0] === 'u1') {
        return voices.map((v) => ({ id: v.rowId, vendor_voice_id: v.vendorId, label: v.label ?? 'x', created_at: 1 }));
      }
      return null;
    },
  });
  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    d1,
    env: {
      IDENTITY_DB: d1,
      TOKEN_LIMITER: allowLimiter,
      ...(hasKey ? { ELEVENLABS_API_KEY: 'xi-unit-test' } : {}),
    },
  };
}

// ── the fail-closed wall — the whole point of shipping before the key ─────

test('clone: no vendor key answers 503 voice_vendor_unconfigured — the wall, not an outage', async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({ hasKey: false });
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'voice_vendor_unconfigured');
    assert.equal(vendor.calls.length, 0, 'the vendor never heard about it');
  } finally {
    vendor.restore();
  }
});

test('clone: an unverified identity is refused before the key is even consulted', async () => {
  const { cookie, env } = await userEnv({ verified: 0, hasKey: false });
  const res = await worker.fetch(
    req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'verification_required');
});

// ── the working path, against vendor-true shapes ──────────────────────────

test('clone: success registers the vendor voice under the SESSION user', async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env, d1 } = await userEnv();
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64, name: 'My Voice' } }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.voiceId, 'v-created');
    assert.ok(typeof body.id === 'string' && body.id.length > 0,
      'the row id is real — a null-id regression must fail here');
    assert.equal(vendor.calls[0].headers['xi-api-key'], 'xi-unit-test');
    const insert = d1.executed.find((e) => /INSERT INTO user_voices/.test(e.sql));
    assert.ok(insert, 'the registration was written');
    assert.equal(insert.binds[1], 'u1', 'bound to the cookie session');
    assert.equal(insert.binds[2], 'v-created', 'the vendor id, not client input');
  } finally {
    vendor.restore();
  }
});

test('clone: the cap refuses the fourth BEFORE any vendor call', async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({
      voices: [
        { rowId: 'r1', vendorId: 'v1' },
        { rowId: 'r2', vendorId: 'v2' },
        { rowId: 'r3', vendorId: 'v3' },
      ],
    });
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'voice_limit_reached');
    assert.equal(vendor.calls.length, 0);
  } finally {
    vendor.restore();
  }
});

test('clone: a vendor refusal writes NO row and never echoes vendor detail', async () => {
  const vendor = stubVendor({ addStatus: 422 });
  try {
    const { cookie, env, d1 } = await userEnv();
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'voice_clone_rejected');
    assert.ok(!JSON.stringify(body).includes('nope'), 'vendor detail stays in the log');
    assert.ok(!d1.executed.some((e) => /INSERT INTO user_voices/.test(e.sql)), 'no phantom registration');
  } finally {
    vendor.restore();
  }
});

test('clone: garbage sample is a 400 before the vendor', async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv();
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: 'not b64 !!!' } }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(vendor.calls.length, 0);
  } finally {
    vendor.restore();
  }
});

// ── deletion: vendor first, row second, own rows only ─────────────────────

test("delete: another user's row id is a 404 with NO vendor call — no oracle, no cross-tenant delete", async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({ voices: [] }); // u1 owns nothing
    const res = await worker.fetch(req(`/api/me/voices/${'9'.repeat(32)}`, { method: 'DELETE', cookie }), env);
    assert.equal(res.status, 404);
    assert.equal(vendor.calls.length, 0);
  } finally {
    vendor.restore();
  }
});

test('delete: vendor confirms (or 404s) before the row dies; a vendor failure keeps the row', async () => {
  const mine = { voices: [{ rowId: 'a'.repeat(32), vendorId: 'v-mine' }] };
  // vendor 500 → row survives
  let vendor = stubVendor({ deleteStatus: 500 });
  try {
    const { cookie, env, d1 } = await userEnv(mine);
    const res = await worker.fetch(req(`/api/me/voices/${'a'.repeat(32)}`, { method: 'DELETE', cookie }), env);
    assert.equal(res.status, 502);
    assert.ok(!d1.executed.some((e) => /DELETE FROM user_voices/.test(e.sql)), 'the row outlives a failed vendor delete');
  } finally {
    vendor.restore();
  }
  // vendor 404 (already gone) → row reaped
  vendor = stubVendor({ deleteStatus: 404 });
  try {
    const { cookie, env, d1 } = await userEnv(mine);
    const res = await worker.fetch(req(`/api/me/voices/${'a'.repeat(32)}`, { method: 'DELETE', cookie }), env);
    assert.equal(res.status, 200);
    const del = d1.executed.find((e) => /DELETE FROM user_voices/.test(e.sql));
    assert.ok(del, 'already-gone at the vendor is fine to reap');
    assert.deepEqual(del.binds, ['a'.repeat(32), 'u1'], 'scoped by row AND user');
  } finally {
    vendor.restore();
  }
});

test('clone: a cap race lost at the DATABASE deletes the vendor voice before the 409 — no orphaned quota', async () => {
  // The listUserVoices pre-check passed (the fixture owns nothing), the
  // vendor created the voice — and then the atomic insert refuses, as it
  // would when a concurrent clone won the last slot. The route must
  // compensate at the vendor and answer 409.
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({
      runMeta: (sql) => (/SELECT COUNT\(\*\) FROM user_voices/.test(sql) ? { changes: 0 } : null),
    });
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'voice_limit_reached');
    const del = vendor.calls.find((c) => c.method === 'DELETE' && c.url.includes('v-created'));
    assert.ok(del, 'the just-created vendor voice was deleted, not orphaned');
  } finally {
    vendor.restore();
  }
});
