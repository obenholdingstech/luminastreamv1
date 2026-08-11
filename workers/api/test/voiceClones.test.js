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
import { fingerprintKey } from '../src/vendorKeys.js';
import { createFakeR2 } from '../testkit/fakeR2.js';

const FP1 = await fingerprintKey('xi-unit-test');

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

async function userEnv({ verified = 1, voices = [], hasKey = true, runMeta, profileVoiceId = null } = {}) {
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
      if (/FROM user_voices WHERE id/.test(sql)) {
        const [id, userId] = binds;
        const hit = voices.find((v) => v.rowId === id && userId === 'u1');
        return hit ? { id: hit.rowId, vendor_voice_id: hit.vendorId, label: hit.label ?? 'x', vendor_account: hit.account ?? FP1, language: hit.language ?? null } : null;
      }
      if (/FROM lens_profiles/.test(sql) && binds[0] === 'u1') {
        return profileVoiceId ? { user_id: 'u1', voice_id: profileVoiceId } : null;
      }
      if (/FROM user_voices WHERE user_id/.test(sql) && binds[0] === 'u1') {
        return voices.map((v) => ({ id: v.rowId, vendor_voice_id: v.vendorId, label: v.label ?? 'x', vendor_account: v.account ?? FP1, language: v.language ?? null, created_at: 1 }));
      }
      return null;
    },
  });
  const r2 = createFakeR2();
  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    d1,
    r2,
    env: {
      IDENTITY_DB: d1,
      TOKEN_LIMITER: allowLimiter,
      AVATARS: r2,
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

test('clone: the cap refuses the SIXTH before any vendor call — five custom voices per user (CEO, 7 Aug 2026, late)', async () => {
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({
      voices: [
        { rowId: 'r1', vendorId: 'v1' },
        { rowId: 'r2', vendorId: 'v2' },
        { rowId: 'r3', vendorId: 'v3' },
        { rowId: 'r4', vendorId: 'v4' },
        { rowId: 'r5', vendorId: 'v5' },
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

test('clone: the DATABASE throwing after vendor create still compensates — no orphan, a 502', async () => {
  // addUserVoice rejecting (D1 outage, or the UNIQUE constraint's loud
  // throw) is not the cap path — before the round-2 fix it escaped the
  // handler with the vendor voice orphaned.
  const vendor = stubVendor();
  try {
    const { cookie, env } = await userEnv({
      runMeta: (sql) => {
        if (/SELECT COUNT\(\*\) FROM user_voices/.test(sql)) throw new Error('d1 exploded');
        return null;
      },
    });
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'voice_clone_rejected');
    const del = vendor.calls.find((c) => c.method === 'DELETE' && c.url.includes('v-created'));
    assert.ok(del, 'the vendor voice was compensated despite the database throwing');
  } finally {
    vendor.restore();
  }
});

test('clone: a compensation that FAILS over HTTP is logged as VOICE-ORPHAN — resolved 500s are not silent successes', async () => {
  const vendor = stubVendor({ deleteStatus: 500 });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const { cookie, env } = await userEnv({
      runMeta: (sql) => (/SELECT COUNT\(\*\) FROM user_voices/.test(sql) ? { changes: 0 } : null),
    });
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 409, 'the refusal stands either way');
    const orphanLine = errors.find((l) => l.includes('VOICE-ORPHAN') && l.includes('v-created'));
    assert.ok(orphanLine, 'the orphan is SAID, greppably, with the vendor id — a human can reap it');
  } finally {
    console.error = originalError;
    vendor.restore();
  }
});

test('the cap IS five — the CEO mandate is a pinned number, not a drifting constant', async () => {
  const { MAX_VOICES_PER_USER } = await import('../src/voiceRoutes.js');
  assert.equal(MAX_VOICES_PER_USER, 5, 'five custom voices per user (CEO, 7 Aug 2026, late)');
});

test('config: voiceCloningEnabled reports key PRESENCE, never the key', async () => {
  const on = await worker.fetch(
    req('/api/auth/config', { method: 'GET' }),
    { ELEVENLABS_API_KEY: 'xi-secret-value', AUTH_LIMITER: allowLimiter },
  );
  const onBody = await on.json();
  assert.equal(onBody.voiceCloningEnabled, true);
  assert.ok(!JSON.stringify(onBody).includes('xi-secret-value'), 'the key itself never leaves');
  const off = await worker.fetch(
    req('/api/auth/config', { method: 'GET' }),
    { AUTH_LIMITER: allowLimiter },
  );
  assert.equal((await off.json()).voiceCloningEnabled, false);
});

// ── the POOL and the HEALER (CEO architecture, 10 Aug 2026) ───────────────

/** A per-key vendor stub: behavior keyed on the xi-api-key header. */
function stubVendorPool(byKey) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.elevenlabs.io')) return original(url, opts);
    const key = opts.headers?.['xi-api-key'];
    calls.push({ url: u, method: opts.method ?? 'GET', key, body: opts.body });
    const plan = byKey[key] ?? { addStatus: 500, addBody: { detail: 'unknown key in stub' } };
    if (u.endsWith('/v1/voices/add')) {
      return new Response(
        JSON.stringify(plan.addStatus === 200 ? { voice_id: plan.voiceId ?? 'v-new' } : plan.addBody ?? { detail: 'nope' }),
        { status: plan.addStatus ?? 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (/\/v1\/voices\//.test(u)) {
      return new Response('{}', { status: plan.deleteStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test('POOL: a payment-dead first key falls through to the second — the clone lands on the healthy account', async () => {
  const vendor = stubVendorPool({
    'sk-dead': { addStatus: 401, addBody: { detail: { status: 'payment_required' } } },
    'sk-live': { addStatus: 200, voiceId: 'v-on-2' },
  });
  try {
    const { cookie, env, d1, r2 } = await userEnv({});
    env.ELEVENLABS_API_KEY = 'sk-dead,sk-live';
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64, name: 'Me' } }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.voiceId, 'v-on-2');
    assert.equal(body.vendorAccount, await fingerprintKey('sk-live'), 'attributed to the CREATING key');
    const adds = vendor.calls.filter((c) => c.url.endsWith('/voices/add'));
    assert.deepEqual(adds.map((c) => c.key), ['sk-dead', 'sk-live'], 'pool order, payment fall-through');
    const insert = d1.executed.find((e) => /INSERT INTO user_voices/.test(e.sql));
    assert.equal(insert.binds[4], await fingerprintKey('sk-live'));
    assert.ok(r2._objects.has(`voice-samples/u1/${insert.binds[0]}`), 'the sample landed, keyed by the row id');
  } finally {
    vendor.restore();
  }
});

test('POOL: a NON-payment rejection does not try the next key — deterministic refusals never double-spend', async () => {
  const vendor = stubVendorPool({
    'sk-one': { addStatus: 400, addBody: { detail: 'corrupted_audio' } },
    'sk-two': { addStatus: 200 },
  });
  try {
    const { cookie, env, r2 } = await userEnv({});
    env.ELEVENLABS_API_KEY = 'sk-one,sk-two';
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 502);
    const adds = vendor.calls.filter((c) => c.url.endsWith('/voices/add'));
    assert.deepEqual(adds.map((c) => c.key), ['sk-one'], 'stopped at the deterministic refusal');
    assert.equal(r2._objects.size, 0, 'the refused clone left no sample behind');
  } finally {
    vendor.restore();
  }
});

test('SAMPLE-FIRST: the vault write precedes the vendor call, and a vault failure refuses the clone entirely', async () => {
  const vendor = stubVendorPool({ 'xi-unit-test': { addStatus: 200 } });
  try {
    const { cookie, env, r2 } = await userEnv({});
    r2.put = async () => {
      throw new Error('r2 down');
    };
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64 } }),
      env,
    );
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'storage_unavailable');
    assert.equal(vendor.calls.length, 0, 'a clone we cannot heal later must not exist — vendor never called');
  } finally {
    vendor.restore();
  }
});

test('HEAL on list: an orphaned row with a sample is re-cloned on the active key — same row, new vendor identity, profile remapped', async () => {
  const vendor = stubVendorPool({ 'sk-live': { addStatus: 200, voiceId: 'v-healed' } });
  try {
    const rowId = 'a'.repeat(32);
    const { cookie, env, d1, r2 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-old', label: 'Me', account: 'kDEADDEAD', language: 'pt-BR' }],
    });
    env.ELEVENLABS_API_KEY = 'sk-live'; // the dead account's key was REMOVED — the operator's signal
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    const res = await worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.voices[0].id, rowId, 'the SAME row');
    assert.equal(body.voices[0].voiceId, 'v-healed', 'the new vendor identity');
    assert.equal(body.voices[0].vendorAccount, await fingerprintKey('sk-live'));
    const upd = d1.executed.find((e) => /UPDATE user_voices SET vendor_voice_id/.test(e.sql));
    assert.deepEqual(upd.binds, [rowId, 'u1', 'v-old', 'v-healed', await fingerprintKey('sk-live')],
      'the write is a COMPARE-AND-SWAP anchored on the vendor id the healer read');
    const remap = d1.executed.find((e) => /UPDATE lens_profiles SET voice_id/.test(e.sql));
    assert.ok(remap, 'the saved selection follows the voice');
    assert.equal(remap.binds[1], 'v-old');
    assert.equal(remap.binds[2], 'v-healed');
    const healAdd = vendor.calls.find((c) => c.url.endsWith('/voices/add'));
    assert.deepEqual(JSON.parse(healAdd.body.get('labels')), { language: 'pt-BR' },
      'the healed clone KEEPS its language conditioning — same voice, new account');
  } finally {
    vendor.restore();
  }
});

test('HEAL no-ops: a healthy row and a sample-less orphan are both left untouched', async () => {
  const vendor = stubVendorPool({ 'xi-unit-test': { addStatus: 200 } });
  try {
    const healthy = 'b'.repeat(32);
    const orphanNoSample = 'c'.repeat(32);
    const { cookie, env } = await userEnv({
      voices: [
        { rowId: healthy, vendorId: 'v-1' }, // account defaults to FP1 = in pool
        { rowId: orphanNoSample, vendorId: 'v-2', account: 'legacy' },
      ],
    });
    const res = await worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env);
    const body = await res.json();
    assert.equal(body.voices[0].voiceId, 'v-1');
    assert.equal(body.voices[1].voiceId, 'v-2', 'no sample, no heal — dashboard-era voices stay put');
    assert.equal(vendor.calls.length, 0, 'zero vendor calls for no-op heals');
  } finally {
    vendor.restore();
  }
});

test('DELETE uses the CREATING key; an account missing from the pool is a hard, named refusal', async () => {
  const vendor = stubVendorPool({ 'sk-live': { deleteStatus: 200 } });
  try {
    const rowId = 'd'.repeat(32);
    const fpLive = await fingerprintKey('sk-live');
    const { cookie, env, r2 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-mine', account: fpLive }],
    });
    env.ELEVENLABS_API_KEY = 'sk-live';
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([1]));
    const ok = await worker.fetch(req(`/api/me/voices/${rowId}`, { method: 'DELETE', cookie }), env);
    assert.equal(ok.status, 200);
    assert.equal(vendor.calls[0].key, 'sk-live', 'the row-creating key made the vendor delete');
    assert.equal(r2._objects.size, 0, 'the sample dies with the voice');

    // The refusal: the row belongs to a key no longer in the pool.
    const rowId2 = 'e'.repeat(32);
    const { cookie: c2, env: e2, r2: r2b } = await userEnv({
      voices: [{ rowId: rowId2, vendorId: 'v-else', account: 'kGONEGONE' }],
    });
    await r2b.put(`voice-samples/u1/${rowId2}`, new Uint8Array([1]));
    const refuse = await worker.fetch(req(`/api/me/voices/${rowId2}`, { method: 'DELETE', cookie: c2 }), e2);
    assert.equal(refuse.status, 503);
    assert.equal((await refuse.json()).error, 'voice_vendor_account_unavailable');
    assert.equal(r2b._objects.size, 1, 'row AND sample survive the refusal');
  } finally {
    vendor.restore();
  }
});

test('SESSION-CREATE heals the SELECTED voice before the policy stamp — the grant carries the healed id', async () => {
  const vendor = stubVendorPool({ 'sk-live': { addStatus: 200, voiceId: 'v-healed' } });
  const grantingRegistry = {
    idFromName: () => 'registry',
    get: () => ({
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            endToken: 'e',
            session: { id: 's1', room: 'r', identity: 'i', expiresAt: Date.now() + 3600_000 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    }),
  };
  try {
    const rowId = 'f'.repeat(32);
    const { cookie, env, r2 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-old', label: 'Me', account: 'kDEADDEAD' }],
      profileVoiceId: 'v-old',
    });
    env.ELEVENLABS_API_KEY = 'sk-live';
    env.SESSION_REGISTRY = grantingRegistry;
    env.SESSION_LIMITER = allowLimiter;
    env.ADMIN_SESSION_SECRET = 'unit-test-session-secret';
    env.LIVEKIT_API_KEY = 'lk';
    env.LIVEKIT_API_SECRET = 'lks';
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([9]));
    const res = await worker.fetch(req('/api/session/create', { method: 'POST', cookie }), env);
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString());
    const policy = JSON.parse(payload.metadata);
    assert.deepEqual(policy.voices, ['v-healed'], 'the stamp carries the HEALED id — the stream proceeds with the true voice');
  } finally {
    vendor.restore();
  }
});

test('HEAL race: two concurrent heals leave exactly ONE tracked clone — the loser deletes its duplicate', async () => {
  let cloneCount = 0;
  const vendor = stubVendorPool({
    'sk-live': { addStatus: 200 },
  });
  // per-call voice ids so the two racers get DIFFERENT clones
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/voices/add')) {
      cloneCount += 1;
      return new Response(JSON.stringify({ voice_id: `v-heal-${cloneCount}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(url, opts);
  };
  try {
    const rowId = '1'.repeat(32);
    let currentVendorId = 'v-old';
    const { cookie, env, r2 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-old', label: 'Me', account: 'kDEADDEAD' }],
      runMeta: (sql, binds) => {
        // A faithful CAS fake: the conditional update wins only when the
        // expected vendor id still matches, and mutates the "row".
        if (/UPDATE user_voices SET vendor_voice_id/.test(sql)) {
          if (binds[2] === currentVendorId) {
            currentVendorId = binds[3];
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        return null;
      },
    });
    env.ELEVENLABS_API_KEY = 'sk-live';
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([1]));
    // Two list requests race their heals.
    const [a, b] = await Promise.all([
      worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env),
      worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const deletes = vendor.calls.filter((c) => c.method === 'DELETE');
    // Either the second heal saw the healed row (0 duplicate, 0 deletes) or
    // it raced, lost the CAS, and deleted its duplicate.
    assert.equal(cloneCount - 1, deletes.length,
      'every clone beyond the first was compensated — exactly one tracked clone survives');
  } finally {
    globalThis.fetch = originalFetch;
    vendor.restore();
  }
});

test('DELETE: a failed sample cleanup keeps the ROW as the retry record — never a silent loss', async () => {
  const vendor = stubVendorPool({ 'xi-unit-test': { deleteStatus: 404 } });
  try {
    const rowId = '2'.repeat(32);
    const { cookie, env, r2, d1 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-x' }],
    });
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([1]));
    const realDelete = r2.delete.bind(r2);
    r2.delete = async () => {
      throw new Error('r2 refused');
    };
    const fail = await worker.fetch(req(`/api/me/voices/${rowId}`, { method: 'DELETE', cookie }), env);
    assert.equal(fail.status, 502);
    assert.equal((await fail.json()).error, 'sample_cleanup_failed');
    assert.ok(!d1.executed.some((e) => /DELETE FROM user_voices/.test(e.sql)),
      'the row SURVIVES a failed sample delete — it IS the retry record');
    // The retry: sample delete works now; the vendor 404 is tolerated
    // (already deleted on the first attempt) — the chain is idempotent.
    r2.delete = realDelete;
    const retry = await worker.fetch(req(`/api/me/voices/${rowId}`, { method: 'DELETE', cookie }), env);
    assert.equal(retry.status, 200);
    assert.equal(r2._objects.size, 0, 'the obligation was discharged on retry');
  } finally {
    vendor.restore();
  }
});

test('HEAL race: a losing compensation that answers HTTP 500 is SAID as VOICE-ORPHAN — resolved failures are not successes', async () => {
  let cloneCount = 0;
  // A BARRIER makes the race deterministic: the first /voices/add holds
  // until the second arrives, so BOTH heals pass the orphan check before
  // either CAS lands — the losing path always executes, and this test can
  // actually fail (a race left to chance asserts nothing on a lucky run).
  let releaseFirst;
  const secondArrived = new Promise((r) => {
    releaseFirst = r;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/voices/add')) {
      cloneCount += 1;
      const mine = cloneCount;
      if (mine === 1) await secondArrived;
      else releaseFirst();
      return new Response(JSON.stringify({ voice_id: `v-heal-${mine}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/api\.elevenlabs\.io\/v1\/voices\//.test(u) && opts.method === 'DELETE') {
      return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, opts);
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const rowId = '3'.repeat(32);
    let currentVendorId = 'v-old';
    const { cookie, env, r2 } = await userEnv({
      voices: [{ rowId, vendorId: 'v-old', label: 'Me', account: 'kDEADDEAD' }],
      runMeta: (sql, binds) => {
        if (/UPDATE user_voices SET vendor_voice_id/.test(sql)) {
          if (binds[2] === currentVendorId) {
            currentVendorId = binds[3];
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        return null;
      },
    });
    env.ELEVENLABS_API_KEY = 'sk-live';
    await r2.put(`voice-samples/u1/${rowId}`, new Uint8Array([1]));
    await Promise.all([
      worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env),
      worker.fetch(req('/api/me/voices', { method: 'GET', cookie }), env),
    ]);
    assert.equal(cloneCount, 2, 'the barrier guarantees both heals cloned — the race is not left to chance');
    const orphanLine = errors.find((l) => l.includes('VOICE-ORPHAN') && l.includes('answered 500'));
    assert.ok(orphanLine, 'the failed compensation is greppable, never silently treated as deleted');
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
});

// ── the clone modal's language field (11 Aug 2026) ────────────────────────

test('clone: language rides to the vendor as labels; junk languages refuse before any spend', async () => {
  const vendor = stubVendorPool({ 'xi-unit-test': { addStatus: 200 } });
  try {
    const { cookie, env } = await userEnv({});
    const res = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64, name: 'Me', language: 'pt-BR' } }),
      env,
    );
    assert.equal(res.status, 200);
    const add = vendor.calls.find((c) => c.url.endsWith('/voices/add'));
    assert.ok(add.body instanceof FormData, 'the clone travels as multipart');
    assert.deepEqual(JSON.parse(add.body.get('labels')), { language: 'pt-BR' },
      'the selected language reached the VENDOR as labels — not just our row');
  } finally {
    vendor.restore();
  }
  const vendor2 = stubVendorPool({ 'xi-unit-test': { addStatus: 200 } });
  try {
    const { cookie, env } = await userEnv({});
    const bad = await worker.fetch(
      req('/api/me/voices', { method: 'POST', cookie, body: { sampleData: SAMPLE_B64, language: 'English!!' } }),
      env,
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'language_invalid');
    assert.equal(vendor2.calls.length, 0, 'refused before the vendor');
  } finally {
    vendor2.restore();
  }
});
