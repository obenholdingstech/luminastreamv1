// Run: node --test — the system-health probes: dead key vs crashed unit,
// answered without SSH. Vendor stubs speak the vendors' real shapes; a
// failing probe yields a row that SAYS what failed, never a blank.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeD1 } from '../testkit/fakeD1.js';
import { probeAgents, probeVendorKeys } from '../src/healthProbes.js';
import { fingerprintKey } from '../src/vendorKeys.js';
import { SESSION_COOKIE, newSessionToken, sessionTokenHash } from '../src/auth.js';

const allowLimiter = { async limit() { return { success: true }; } };

function stubWorld(handlers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers ?? {} });
    for (const [pattern, respond] of handlers) {
      if (u.includes(pattern)) return respond(u, opts);
    }
    return original(url, opts);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('vendor probes: every pool key gets a row — ok with quota, payment, rejected, unreachable', async () => {
  const s = stubWorld([
    [
      'api.elevenlabs.io',
      (u, opts) => {
        const key = opts.headers['xi-api-key'];
        if (key === 'el-good') return jsonRes({ status: 'active', character_count: 300, character_limit: 1000 });
        if (key === 'el-broke') return jsonRes({ status: 'past_due' });
        return jsonRes({ detail: 'invalid' }, 401);
      },
    ],
    [
      'api.decart.ai',
      (u, opts) => {
        const key = opts.headers['x-api-key'];
        if (key === 'dk-good') return jsonRes({ apiKey: 'tok' });
        return jsonRes({ detail: 'Insufficient credits' }, 422);
      },
    ],
  ]);
  try {
    const rows = await probeVendorKeys({
      ELEVENLABS_API_KEY: 'el-good,el-broke,el-dead',
      DECART_API_KEY: 'dk-good,dk-broke',
    });
    const by = Object.fromEntries(
      await Promise.all(
        ['el-good', 'el-broke', 'el-dead', 'dk-good', 'dk-broke'].map(async (k) => [k, await fingerprintKey(k)]),
      ),
    );
    const find = (fp) => rows.find((r) => r.fingerprint === fp);
    assert.equal(find(by['el-good']).status, 'ok');
    assert.deepEqual(find(by['el-good']).quota, { used: 300, limit: 1000 }, 'quota rides the healthy row');
    assert.equal(find(by['el-broke']).status, 'payment', 'past_due is amber, not green');
    assert.equal(find(by['el-dead']).status, 'rejected');
    assert.equal(find(by['dk-good']).status, 'ok');
    assert.equal(find(by['dk-broke']).status, 'payment', 'the live-verified 422 broke-signal');
    for (const r of rows) {
      assert.ok(!JSON.stringify(r).includes('el-good') && !JSON.stringify(r).includes('dk-good'),
        'keys appear only as fingerprints');
    }
  } finally {
    s.restore();
  }
});

test('agent probe: an echo-* participant in the room means LIVE; its absence means down; LiveKit silence says so', async () => {
  const s = stubWorld([
    [
      '/twirp/livekit.RoomService/ListParticipants',
      (u, opts) => {
        const { room } = JSON.parse(opts.body);
        if (room === 'room-live') {
          return jsonRes({ participants: [{ identity: 'echo-convert-agent' }, { identity: 'speaker-1' }] });
        }
        if (room === 'room-down') return jsonRes({ participants: [{ identity: 'speaker-2' }] });
        return jsonRes({}, 500);
      },
    ],
  ]);
  try {
    const rows = await probeAgents({
      SESSION_ROOMS: 'room-live, room-down, room-broken',
      LIVEKIT_URL: 'wss://unit.livekit.cloud',
      LIVEKIT_API_KEY: 'lk',
      LIVEKIT_API_SECRET: 'lks',
    });
    assert.deepEqual(rows[0], { room: 'room-live', agentLive: true, agentIdentity: 'echo-convert-agent', participants: 2 });
    assert.equal(rows[1].agentLive, false, 'no echo-* participant = the unit is not serving');
    assert.equal(rows[2].agentLive, null, 'LiveKit failure is UNKNOWN, said plainly — not false');
  } finally {
    s.restore();
  }
});

test('agent probe without LiveKit config: rows say unknown rather than erroring', async () => {
  const rows = await probeAgents({ SESSION_ROOMS: 'r1' });
  assert.equal(rows[0].agentLive, null);
  assert.match(rows[0].detail, /not configured/);
});

test('/api/admin/health: role-walled like every admin route', async () => {
  const sessionToken = newSessionToken();
  const tokenHash = await sessionTokenHash(sessionToken);
  const d1 = createFakeD1({
    respond: (sql, binds) =>
      /FROM auth_sessions/.test(sql) && binds[0] === tokenHash
        ? { user_id: 'u1', last_seen_at: Math.floor(Date.now() / 1000), display_name: 'u', role: 'user', verified: 1 }
        : null,
  });
  const env = { IDENTITY_DB: d1, TOKEN_LIMITER: allowLimiter };
  const anon = await worker.fetch(
    new Request('https://api.example/api/admin/health', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', Origin: 'https://admin.luminastream.live' },
    }),
    env,
  );
  assert.equal(anon.status, 401);
  const asUser = await worker.fetch(
    new Request('https://api.example/api/admin/health', {
      headers: {
        'CF-Connecting-IP': '203.0.113.7',
        Origin: 'https://admin.luminastream.live',
        Cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
    }),
    env,
  );
  assert.equal(asUser.status, 403);
});

test('vendor probe: an ElevenLabs 500/429 is UNREACHABLE, never a payment misdiagnosis', async () => {
  const s = stubWorld([
    ['api.elevenlabs.io', (u, opts) => {
      const key = opts.headers['xi-api-key'];
      if (key === 'el-500') return jsonRes({ detail: 'internal' }, 500);
      if (key === 'el-429') return jsonRes({ detail: 'slow down' }, 429);
      return jsonRes({ detail: { status: 'quota_exceeded' } }, 429);
    }],
  ]);
  try {
    const rows = await probeVendorKeys({ ELEVENLABS_API_KEY: 'el-500,el-429,el-quota' });
    assert.equal(rows[0].status, 'unreachable', 'a 500 is their outage, not our invoice');
    assert.equal(rows[1].status, 'unreachable', 'a bare 429 is rate limiting');
    assert.equal(rows[2].status, 'payment', 'an explicit billing signal still reads payment');
  } finally {
    s.restore();
  }
});
