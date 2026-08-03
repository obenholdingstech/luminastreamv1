// Run: node --test workers/api/test/whitelabel.test.js
//
// P2c — the committed topology, every canon rule as an assertion: the ordering
// that prevents orphans, the walls that cap spend, the trust boundary on the
// billing summary, the executioner's bounded retries, and the O(1) budget
// (reserve + bind + settle = 3 DO requests per video session; control ops
// cost zero).

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { SpendLedger, KILL_RETRIES, SETTLE_SLACK_SECONDS } from '../src/spendLedger.js';
import { createRegistryHarness } from '../testkit/registryHarness.js';

const ADMIN_PASSWORD = 'correct horse battery staple';
const STUDIO = 'https://studio.luminastream.live';
const allowLimiter = { async limit() { return { success: true }; } };

function setup({ perSession = 60, total = 600 } = {}) {
  const env = {
    ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: 'unit-test-session-secret',
    VERIFY_LIMITER: allowLimiter,
    VIDEO_LIMITER: allowLimiter,
    VIDEO_ENABLED: 'true',
    DECART_API_KEY: 'raw-vendor-key',
    MAX_VIDEO_SECONDS_PER_SESSION: String(perSession),
    MAX_VIDEO_SECONDS_TOTAL: String(total),
  };
  const h = createRegistryHarness({ env, startAt: Date.now(), cls: SpendLedger });
  env.VIDEO_LEDGER = h.namespace;
  return { env, h };
}

// A scriptable Decart: every vendor route in one stub, with a call journal so
// tests can assert what the vendor was told — and, as important, what it was
// never told.
//
// CONTRACT FIXTURE, not an invention. Every default response below mirrors
// the live API as verified on 3 Aug 2026 (signaling-proxy-http docs + a real
// 201 exchange): snake_case fields, the answer as an RTCSessionDescription-
// shaped object, the ICE ETag as a response HEADER, PATCH answering 204, and
// the DELETE summary's `billed_seconds`. The previous stub spoke this file's
// own camelCase back to it — which is precisely how 17 green tests shipped a
// Worker whose first real vendor call was an HTTP 400.
function stubVendor(overrides = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.decart.ai')) return original(url, opts);
    const entry = {
      url: u,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(entry);
    if (u.endsWith('/v1/client/tokens')) {
      return (
        overrides.tokens?.(entry) ??
        new Response(JSON.stringify({ apiKey: 'constrained-client-token' }), { status: 200 })
      );
    }
    if (u.endsWith('/v1/realtime/sessions') && entry.method === 'POST') {
      return (
        overrides.create?.(entry) ??
        new Response(
          JSON.stringify({
            session_id: 'decart-sess-1',
            sdp: { type: 'answer', sdp: 'v=0 answer' },
            ice_servers: [{ urls: ['stun:stun.l.google.com:19302'] }],
            events: {
              url: 'https://api.decart.ai/v1/realtime/sessions/decart-sess-1/events',
              event_token: 'sse-event-token',
              expires_at: '2026-08-03T13:00:00Z',
            },
            expires_at: '2026-08-03T13:00:00Z',
          }),
          { status: 201, headers: { ETag: '"1"' } },
        )
      );
    }
    // SESSION CONTROL AUTH, part of the contract: Decart accepts control ops
    // (ICE PATCH, prompt, DELETE) only from the client token that created the
    // session. The raw account key answers 401 — verified live 3 Aug 2026,
    // where it broke the deployed end path and would have broken every kill.
    const sessionControl =
      (/\/v1\/realtime\/sessions\/[^/]+$/.test(u) &&
        (entry.method === 'DELETE' || entry.method === 'PATCH')) ||
      u.endsWith('/prompt') ||
      u.endsWith('/image');
    if (sessionControl && entry.headers['x-api-key'] !== 'constrained-client-token') {
      return new Response(
        JSON.stringify({ title: 'Invalid API key', status: 401 }),
        { status: 401 },
      );
    }
    if (/\/v1\/realtime\/sessions\/[^/]+$/.test(u) && entry.method === 'DELETE') {
      return (
        overrides.del?.(entry) ??
        new Response(
          JSON.stringify({
            session_id: 'decart-sess-1',
            duration_seconds: 41.2,
            billed_seconds: 41.2,
            reason: 'disconnect',
          }),
          { status: 200 },
        )
      );
    }
    if (/\/v1\/realtime\/sessions\/[^/]+$/.test(u) && entry.method === 'PATCH') {
      return overrides.patch?.(entry) ?? new Response(null, { status: 204, headers: { ETag: '"2"' } });
    }
    if (u.endsWith('/prompt')) {
      return overrides.prompt?.(entry) ?? new Response('{"prompt":"ok"}', { status: 200 });
    }
    if (u.endsWith('/image')) {
      return overrides.image?.(entry) ?? new Response('{}', { status: 200 });
    }
    return new Response('{"error":"unstubbed"}', { status: 500 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function req(path, { method = 'POST', origin = STUDIO, token, body } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  if (token) headers['X-Admin-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.luminastream.live${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function adminToken(env) {
  const res = await worker.fetch(
    req('/api/admin/verify', { body: { password: ADMIN_PASSWORD } }),
    env,
  );
  return (await res.json()).token;
}

const createSession = (env, token, body = { sdpOffer: 'v=0 offer' }) =>
  worker.fetch(req('/api/video/session', { token, body }), env);

// ─── create: ordering, walls, leaks ────────────────────────────────────────

test('create: reserve → constrained token → vendor create → bind → THEN the browser', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  h.resetCounts();
  const res = await createSession(env, token, { sdpOffer: 'v=0 offer', requestedSeconds: 45 });
  assert.equal(res.status, 200);
  const out = await res.json();

  // The vendor sequence, in the canon's order.
  assert.equal(vendor.calls[0].url.endsWith('/v1/client/tokens'), true);
  assert.equal(vendor.calls[0].headers['x-api-key'], 'raw-vendor-key');
  assert.equal(vendor.calls[0].body.constraints.realtime.maxSessionDuration, 45, 'wall #2 rides');
  assert.equal(
    vendor.calls[0].body.expiresIn,
    45 + 300,
    'the token outlives the grant by the settle+kill window — it is the ONLY credential that can end the session',
  );
  assert.equal(vendor.calls[1].url.endsWith('/v1/realtime/sessions'), true);
  assert.equal(
    vendor.calls[1].headers['x-api-key'],
    'constrained-client-token',
    'the session is created with the CONSTRAINED token, not the raw key',
  );
  assert.equal(vendor.calls[1].body.model, 'lucy-2.5');
  // The offer travels in Decart's dialect — the exact field the live API
  // refused with "body.sdp: Field required" when this was `sdpOffer`.
  assert.deepEqual(
    vendor.calls[1].body.sdp,
    { type: 'offer', sdp: 'v=0 offer' },
    'the offer is an RTCSessionDescription-shaped object named sdp',
  );

  // What the browser gets — and does not.
  assert.equal(out.sessionId, 'decart-sess-1');
  assert.ok(out.controlToken.includes('.'));
  assert.equal(out.vendor.sdp.sdp, 'v=0 answer');
  assert.equal(out.vendor.events.event_token, 'sse-event-token', 'SSE auth passes through');
  assert.equal(out.vendor.etag, '"1"', "the create response's ETag HEADER is lifted into the payload");
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes('raw-vendor-key'), 'the raw key never leaves');
  assert.ok(!raw.includes('constrained-client-token'), 'neither does the Worker-only token');
  assert.ok(!raw.includes('settleToken') && !raw.includes(out.reservationId ?? '@'), 'no settle bearer in the browser flow');

  // O(1): reserve + bind = 2 DO requests at create.
  assert.equal(h.counts().requests, 2, 'create costs exactly reserve + bind');
});

test('create: a failed BIND compensates with a vendor DELETE and returns the hold', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  // Sabotage bind: intercept the ledger namespace to fail /bind only.
  const realGet = env.VIDEO_LEDGER.get.bind(env.VIDEO_LEDGER);
  env.VIDEO_LEDGER = {
    idFromName: env.VIDEO_LEDGER.idFromName.bind(env.VIDEO_LEDGER),
    get(id) {
      const stub = realGet(id);
      return {
        async fetch(request) {
          if (new URL(request.url).pathname === '/bind') {
            return new Response('{"ok":false,"error":"unknown_reservation"}', { status: 404 });
          }
          return stub.fetch(request);
        },
      };
    },
  };

  const res = await createSession(env, token);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'vendor_session_failed');

  const del = vendor.calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'the orphan was killed with the id in hand');
  assert.match(del.url, /decart-sess-1$/);

  // And the money came home.
  const budget = await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  assert.equal((await budget.json()).spentSeconds, 0);
  assert.equal(h.pendingAlarm(), null);
});

test('create: a 201 WITHOUT an ETag header fails closed and compensates', async (t) => {
  // The ETag is the If-Match seed for every ICE PATCH; a session born without
  // one is paid and mute. The Worker must refuse it — and because the vendor
  // DID create it, the compensation path must kill it and return the hold.
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor({
    create: () =>
      new Response(
        JSON.stringify({ session_id: 'decart-sess-1', sdp: { type: 'answer', sdp: 'v=0 answer' } }),
        { status: 201 }, // no ETag header
      ),
  });
  t.after(vendor.restore);

  const res = await createSession(env, token);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'vendor_session_failed');
  const del = vendor.calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'the mute session was killed, not abandoned');
  assert.match(del.url, /decart-sess-1$/);
  const budget = await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  const b = await budget.json();
  assert.equal(b.spentSeconds, 0, 'and the hold came home');
  assert.equal(b.openReservations, 0);
});

test("create: the vendor's INSUFFICIENT CREDITS surfaces as itself, hold returned", async (t) => {
  // Seen live 3 Aug 2026: Decart 422 'Insufficient credits' reached the CEO
  // as a mystery 502 and read as a proxy regression. Money problems are
  // named — 402, vendor_credits_exhausted — and cost nothing here either.
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor({
    create: () =>
      new Response(
        JSON.stringify({ title: 'Insufficient credits', detail: 'Insufficient credits', status: 422 }),
        { status: 422 },
      ),
  });
  t.after(vendor.restore);

  const res = await createSession(env, token);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'vendor_credits_exhausted');
  const budget = await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  const b = await budget.json();
  assert.equal(b.spentSeconds, 0, 'a broke vendor account must not eat OUR meter');
  assert.equal(b.openReservations, 0);
});

test('create: a vendor create failure returns the hold and binds nothing', async (t) => {
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor({
    create: () => new Response('{"error":"boom"}', { status: 500 }),
  });
  t.after(vendor.restore);

  const res = await createSession(env, token);
  assert.equal(res.status, 502);
  const budget = await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  const b = await budget.json();
  assert.equal(b.spentSeconds, 0);
  assert.equal(b.openReservations, 0);
});

// ─── control: stateless, scoped, zero ledger cost ──────────────────────────

test('create: a session ALWAYS has work to do — promptless gets the default, yours wins, an image is enough', async (t) => {
  // Measured live 3 Aug 2026: a create with no prompt and no reference image
  // connects, bills, and generates NOTHING — the blank drill. The Worker
  // guarantees the vendor is never asked to do nothing.
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  await createSession(env, token, { sdpOffer: 'v=0 offer' });
  const bare = vendor.calls.find((c) => c.url.endsWith('/v1/realtime/sessions'));
  assert.match(bare.body.prompt, /same person/, 'a promptless session gets the neutral default');

  vendor.calls.length = 0;
  await createSession(env, token, {
    sdpOffer: 'v=0 offer',
    prompt: 'anime style',
    imageData: 'data:image/png;base64,aGVsbG8=',
  });
  const prompted = vendor.calls.find((c) => c.url.endsWith('/v1/realtime/sessions'));
  assert.equal(prompted.body.prompt, 'anime style', "the user's prompt is never overridden");
  assert.equal(prompted.body.image_data, 'aGVsbG8=', 'and it rides BESIDE a reference, not instead of one');

  vendor.calls.length = 0;
  await createSession(env, token, {
    sdpOffer: 'v=0 offer',
    imageData: 'data:image/png;base64,aGVsbG8=',
  });
  const withImage = vendor.calls.find((c) => c.url.endsWith('/v1/realtime/sessions'));
  assert.equal(withImage.body.prompt, undefined, 'a reference image is work in itself — no default forced beside it');
  assert.equal(withImage.body.image_data, 'aGVsbG8=');
});

test('create: a reference avatar rides the vendor create as image_data', async (t) => {
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  const res = await createSession(env, token, {
    sdpOffer: 'v=0 offer',
    imageData: 'data:image/png;base64,aGVsbG8=',
  });
  assert.equal(res.status, 200);
  const create = vendor.calls.find((c) => c.url.endsWith('/v1/realtime/sessions'));
  assert.equal(create.body.image_data, 'aGVsbG8=', 'data-URL prefix stripped, bare base64 to the vendor');
});

test('create: an invalid avatar is refused BEFORE any hold is taken', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  h.resetCounts();
  const res = await createSession(env, token, {
    sdpOffer: 'v=0 offer',
    imageData: 'not/base64 at all!!',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'image_invalid');
  assert.equal(h.counts().requests, 0, 'no reservation was ever created for a bad upload');
  assert.equal(vendor.calls.length, 0, 'and the vendor never heard about it');
});

test('the image action swaps identity mid-session with the CREATING token, zero ledger cost', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  const out = await (await createSession(env, token)).json();
  h.resetCounts();

  const res = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/image`, {
      token,
      body: {
        controlToken: out.controlToken,
        imageData: 'data:image/jpeg;base64,bmV3LWZhY2U=',
        prompt: 'keep the lighting',
      },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const img = vendor.calls.find((c) => c.url.endsWith('/image'));
  // The fixture 401s any credential but the creating token, so a 200 IS the
  // proof the sealed token was unsealed and presented.
  assert.equal(img.body.image_data, 'bmV3LWZhY2U=');
  assert.equal(img.body.prompt, 'keep the lighting');
  assert.equal(h.counts().requests, 0, 'identity swaps never touch the Durable Object');

  const bad = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/image`, {
      token,
      body: { controlToken: out.controlToken, imageData: '!!' },
    }),
    env,
  );
  assert.equal(bad.status, 400, 'a bad image is refused before a byte reaches the vendor');
});

test('control ops verify the token statelessly and cost ZERO ledger requests', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  const out = await (await createSession(env, token)).json();
  h.resetCounts();

  const cand = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/candidates`, {
      token,
      body: { controlToken: out.controlToken, candidates: [{ candidate: 'c1' }], etag: 'etag-1' },
    }),
    env,
  );
  assert.equal(cand.status, 200);
  const patch = vendor.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.headers['If-Match'], 'etag-1', 'ETag forwarded');
  assert.equal(
    (await cand.json()).etag,
    '"2"',
    "the vendor's ROTATED ETag comes back to the browser — the next send's If-Match",
  );

  const prompt = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/prompt`, {
      token,
      body: { controlToken: out.controlToken, prompt: 'a calm office' },
    }),
    env,
  );
  assert.equal(prompt.status, 200);

  assert.equal(h.counts().requests, 0, 'ICE and prompts never touch the Durable Object');
});

test('a control token for one session opens no other, and a forgery opens nothing', async (t) => {
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);
  const out = await (await createSession(env, token)).json();

  const wrongSid = await worker.fetch(
    req('/api/video/session/other-session/end', {
      token,
      body: { controlToken: out.controlToken },
    }),
    env,
  );
  assert.equal(wrongSid.status, 403);

  const forged = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, {
      token,
      body: { controlToken: `${out.controlToken.split('.')[0]}.AAAA` },
    }),
    env,
  );
  assert.equal(forged.status, 403);
});

// ─── end: vendor-truth, and ONLY vendor-truth ──────────────────────────────

test('end: the Worker deletes, reads the summary, settles — the browser\'s "summary" is IGNORED', async (t) => {
  const { env, h } = setup({ perSession: 60 });
  const token = await adminToken(env);
  const vendor = stubVendor({
    del: () => new Response(JSON.stringify({ billed_seconds: 41.2 }), { status: 200 }),
  });
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 60 })).json();
  h.resetCounts();

  const end = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, {
      token,
      // The attack from the canon: a client that could report its own bill
      // would report a small one.
      body: { controlToken: out.controlToken, vendorSummary: { billed_seconds: 1 } },
    }),
    env,
  );
  assert.equal(end.status, 200);
  const settled = await end.json();
  assert.equal(settled.usedSeconds, 42, "ceil(41.2) from DECART's response, not the browser's 1");
  assert.equal(settled.refundedSeconds, 18);
  assert.equal(h.counts().requests, 1, 'end costs exactly one DO request');

  const budget = await (await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env)).json();
  assert.equal(budget.spentSeconds, 42);
});

test('end: vendor overage past the grant is clamped for the meter, recorded for reconciliation', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor({
    del: () => new Response(JSON.stringify({ billed_seconds: 32.4 }), { status: 200 }),
  });
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  const end = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  );
  const settled = await end.json();
  assert.equal(settled.usedSeconds, 30, 'the dev meter clamps to the grant');
  assert.equal(settled.overageSeconds, 3, 'the ~2–3s granularity the probe measured, recorded');

  const rows = [...h.stored().entries()].filter(([k]) => k.startsWith('settlement:'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1].source, 'vendor');
  assert.equal(rows[0][1].vendorSummary.billed_seconds, 32.4, 'raw summary stored VERBATIM');
});

test('end is idempotent: a second end settles nothing and refunds nothing twice', async (t) => {
  const { env } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);
  const out = await (await createSession(env, token)).json();

  const first = await (await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  )).json();
  assert.equal(first.settled, true);
  const second = await (await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  )).json();
  assert.equal(second.settled, false);
  assert.equal(second.reason, 'unknown_session');
});

// ─── the executioner ───────────────────────────────────────────────────────

test('EXECUTIONER: an abandoned bound session is DELETEd by the alarm — 1 alarm, 1 kill', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  const killsBefore = vendor.calls.filter((c) => c.method === 'DELETE').length;
  h.resetCounts();

  // Nobody ends the session. The tab died.
  await h.advanceBy((30 + SETTLE_SLACK_SECONDS + 1) * 1000);

  const kills = vendor.calls.filter((c) => c.method === 'DELETE').length - killsBefore;
  assert.equal(kills, 1, 'the vendor session was killed');
  assert.equal(h.counts().alarms, 1, 'one wakeup');
  assert.equal(h.counts().requests, 0, 'no DO requests — the alarm is not a request');

  const rows = [...h.stored().entries()].filter(([k]) => k.startsWith('settlement:'));
  assert.equal(rows[0][1].source, 'reaper');
  assert.equal(rows[0][1].vendorKilled, true);
  assert.equal(rows[0][1].orphanFlag, false);
  assert.equal(rows[0][1].usedSeconds, 30, 'abandonment stays fully spent');
  assert.equal(h.pendingAlarm(), null);
});

test('EXECUTIONER: retries are BOUNDED — a dead vendor costs 1+KILL_RETRIES alarms, then an orphan flag', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  let deletes = 0;
  const vendor = stubVendor({
    del: () => {
      deletes += 1;
      return new Response('{"error":"vendor down"}', { status: 503 });
    },
  });
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  assert.ok(out.sessionId);
  h.resetCounts();

  // Far past every retry window.
  await h.advanceBy((30 + SETTLE_SLACK_SECONDS + 300) * 1000);

  assert.equal(deletes, 1 + KILL_RETRIES, 'exactly the retry budget, never more');
  assert.equal(h.counts().alarms, 1 + KILL_RETRIES, 'at most 1+R alarms per overrun — the qualified constant');
  const rows = [...h.stored().entries()].filter(([k]) => k.startsWith('settlement:'));
  assert.equal(rows[0][1].orphanFlag, true, 'silent about its bill, never about its existence');
  assert.equal(rows[0][1].usedSeconds, 30, 'the debit stands regardless');
  assert.equal(h.pendingAlarm(), null, 'and the ledger is at rest');
});

test('EXECUTIONER: a 404 from the vendor is a SUCCESS — the session was already gone', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor({
    del: () => new Response('{"error":"not found"}', { status: 404 }),
  });
  t.after(vendor.restore);

  await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  h.resetCounts();
  await h.advanceBy((30 + SETTLE_SLACK_SECONDS + 1) * 1000);

  assert.equal(h.counts().alarms, 1, 'no retries for an already-dead session');
  const rows = [...h.stored().entries()].filter(([k]) => k.startsWith('settlement:'));
  assert.equal(rows[0][1].vendorKilled, true);
  assert.equal(rows[0][1].orphanFlag, false);
});

test('a budget read never talks to the vendor, even with kills pending', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  // Cross the expiry WITHOUT the alarm (delayed delivery) — the kill is owed.
  h.warpBy((30 + SETTLE_SLACK_SECONDS + 1) * 1000);
  const callsBefore = vendor.calls.length;

  const budget = await (await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env)).json();
  assert.equal(vendor.calls.length, callsBefore, 'the request path NEVER calls Decart');
  assert.equal(budget.spentSeconds, 30, 'the pending-kill debit still stands');
});

// ─── the full O(1) budget ──────────────────────────────────────────────────

test('ORACLE white-label: a full session costs exactly 3 DO requests — create(2) + end(1) — and 0 alarms', async (t) => {
  const { env, h } = setup();
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  h.resetCounts();
  const out = await (await createSession(env, token)).json();
  // A conversation's worth of control traffic, all free.
  for (let i = 0; i < 5; i += 1) {
    await worker.fetch(
      req(`/api/video/session/${out.sessionId}/candidates`, {
        token,
        body: { controlToken: out.controlToken, candidates: [{ candidate: `c${i}` }] },
      }),
      env,
    );
  }
  await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  );

  assert.equal(h.counts().requests, 3, 'reserve + bind + settle, whatever the session length');
  assert.equal(h.counts().alarms, 0);
});

// ─── a failed kill must never destroy the executioner's ammunition ─────────

test('end: a FAILED vendor delete does NOT settle — the reservation survives for the alarm', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  let deleteAttempts = 0;
  const vendor = stubVendor({
    del: () => {
      deleteAttempts += 1;
      // Down for the user's end, and for every retry after it.
      return new Response('{"error":"vendor down"}', { status: 503 });
    },
  });
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  const end = await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  );
  assert.equal(end.status, 502);
  assert.equal((await end.json()).error, 'vendor_delete_failed');

  // The money is still held AND the record is still there — settling would
  // have deleted the reservation and left a running session unowned.
  const mid = await (await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env)).json();
  assert.equal(mid.spentSeconds, 30, 'no refund for a session that may still run');
  assert.equal(mid.openReservations, 1, "the executioner's ammunition survives");

  // And the alarm inherits the kill, with its bounded retries.
  await h.advanceBy((30 + SETTLE_SLACK_SECONDS + 300) * 1000);
  assert.equal(deleteAttempts, 1 + 1 + KILL_RETRIES, 'the user end, then the bounded retry budget');
  const rows = [...h.stored().entries()].filter(([k]) => k.startsWith('settlement:'));
  assert.equal(rows[0][1].orphanFlag, true, 'flagged, never silent');
});

test('create: a compensating delete that FAILS settles fully spent, not zero', async (t) => {
  // Refunding a session that may still be running pays for someone else's
  // stream. The ledger record is about to be destroyed either way, so this is
  // the last moment anyone can account for it.
  const { env } = setup({ perSession: 40 });
  const token = await adminToken(env);
  const vendor = stubVendor({
    del: () => new Response('{"error":"down"}', { status: 500 }),
  });
  t.after(vendor.restore);

  const realGet = env.VIDEO_LEDGER.get.bind(env.VIDEO_LEDGER);
  env.VIDEO_LEDGER = {
    idFromName: env.VIDEO_LEDGER.idFromName.bind(env.VIDEO_LEDGER),
    get(id) {
      const stub = realGet(id);
      return {
        async fetch(request) {
          if (new URL(request.url).pathname === '/bind') {
            return new Response('{"ok":false,"error":"unknown_reservation"}', { status: 404 });
          }
          return stub.fetch(request);
        },
      };
    },
  };

  const res = await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 40 });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'vendor_session_orphaned', 'named, not generic');

  const budget = await (await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env)).json();
  assert.equal(budget.spentSeconds, 40, 'an unkillable session is charged, not refunded');
});

test('a budget read does not push a pending kill further out', async (t) => {
  const { env, h } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor();
  t.after(vendor.restore);

  await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  h.warpBy((30 + SETTLE_SLACK_SECONDS + 1) * 1000); // due, alarm not delivered

  const first = await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  assert.equal(first.status, 200);
  const armedAfterFirst = h.pendingAlarm();
  assert.ok(armedAfterFirst > h.now(), 'the deferred kill is armed just ahead');

  // Repeated reads WITHIN the armed window — the case that matters. A clamp
  // recomputed from now() on every sweep would push the kill a second further
  // out on each read and write storage for the privilege.
  h.warpBy(200);
  await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);
  h.warpBy(200);
  await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env);

  assert.equal(
    h.pendingAlarm(),
    armedAfterFirst,
    'repeated reads must not rewrite the alarm and delay the executioner',
  );
});

test('a negative vendor billed value cannot become an over-refund', async (t) => {
  const { env } = setup({ perSession: 30 });
  const token = await adminToken(env);
  const vendor = stubVendor({
    del: () => new Response(JSON.stringify({ billed_seconds: -100 }), { status: 200 }),
  });
  t.after(vendor.restore);

  const out = await (await createSession(env, token, { sdpOffer: 'v=0', requestedSeconds: 30 })).json();
  const settled = await (await worker.fetch(
    req(`/api/video/session/${out.sessionId}/end`, { token, body: { controlToken: out.controlToken } }),
    env,
  )).json();
  assert.equal(settled.usedSeconds, 0);
  assert.equal(settled.refundedSeconds, 30, 'refund is bounded by the grant, never more');
  const budget = await (await worker.fetch(req('/api/video/budget', { method: 'GET', token }), env)).json();
  assert.equal(budget.spentSeconds, 0, 'and never negative');
});
