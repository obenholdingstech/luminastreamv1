// LuminaStream API Worker — our first owned backend.
//
//   GET  /api/health           → { ok, version }                (public)
//   POST /api/admin/verify     → { password } → { ok, token }   (rate-limited hard)
//   POST /api/livekit/token    → { room, identity } → LiveKit access token
//                                (requires a valid X-Admin-Token, rate-limited)
//   POST /api/session/create   → allocates a room + identity + grant   ┐ P1:
//   POST /api/session/end      → releases the slot                     │ the
//   GET  /api/session/capacity → { live, capacity, available }          ┘ session layer
//
// This is the path real users will eventually take, replacing the DEV-ONLY
// `scripts/generate-livekit-token.js`. The LiveKit API secret lives ONLY in
// the Worker env (wrangler secret put) and never reaches the browser.

import { handlePreflight, corsHeaders } from './cors.js';
import { constantTimeCompareSecrets } from './crypto.js';
import { signSession, verifySession } from './session.js';
import { base64UrlEncode, base64UrlEncodeJson, base64UrlDecode, decodeJson, hmacSha256, timingSafeEqual, seal, unseal } from './crypto.js';
import { mintLiveKitToken } from './livekit.js';
import { SessionRegistry } from './sessionRegistry.js';
import { SpendLedger } from './spendLedger.js';
import { createAuthRoutes } from './authRoutes.js';
import { createDb } from './db.js';
import { mayStartSession, resolveUserSession } from './userSession.js';

const VERSION = '0.1.0';

function json(body, { status = 200, origin, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
      // CORS last: an extra header may never displace the allow-origin the
      // browser needs to read this response at all.
      ...corsHeaders(origin),
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

// Rate-limit outcomes. Three, not two: "the limiter said no" and "there is no
// limiter" are different facts and must produce different behaviour.
const LIMIT_OK = 'ok';
const LIMIT_EXCEEDED = 'exceeded';
const LIMIT_UNAVAILABLE = 'unavailable';

// FAILS CLOSED. This previously returned "not limited" when the binding was
// missing, so that a dependency-free `node --test` run could exercise the
// endpoints. The cost of that convenience: a deploy that drops the
// `ratelimits` block from wrangler.jsonc turns /api/admin/verify — a password
// oracle — into an unthrottled one, with nothing anywhere reporting an error.
// A silent loss of a security control is the worst shape a bug can take.
//
// The tests now inject a permissive limiter instead (see test/http.test.js),
// which is more honest anyway: a test of the non-throttled path should say so
// rather than rely on a production fallback.
//
// A limiter that THROWS is treated the same as a missing one. Cloudflare's
// binding can fail transiently, and "the throttle broke" must never resolve to
// "so let everything through".
async function checkRateLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return LIMIT_UNAVAILABLE;
  try {
    const result = await limiter.limit({ key });
    // `success` must be an actual boolean. A limiter that returns undefined —
    // an API shape change, a stub that forgot the field — would otherwise be
    // read as falsy and reported as EXCEEDED, silently 429ing every request on
    // the endpoint while looking like ordinary throttling in the logs. Only a
    // literal `false` means "over limit"; anything else means we do not know,
    // and not knowing is UNAVAILABLE.
    if (typeof result?.success !== 'boolean') return LIMIT_UNAVAILABLE;
    return result.success ? LIMIT_OK : LIMIT_EXCEEDED;
  } catch (err) {
    // Logged, because the whole point of failing closed is to make a broken
    // guard visible. Without this an operator can only infer it from a rising
    // 503 rate, and cannot tell a transient binding failure from a permanent
    // misconfiguration.
    console.error('rate limiter binding failed', err);
    return LIMIT_UNAVAILABLE;
  }
}

// The refusal for a non-OK outcome, or null to proceed.
//
// 429 and 503 are deliberately distinct. 429 says "you did too much" and is
// the client's problem; 503 says "we cannot safely serve this" and is ours. A
// missing binding reported as 429 would look like ordinary throttling in the
// logs, which is exactly how it would go unnoticed for a month.
function rateLimitRefusal(state, origin) {
  if (state === LIMIT_OK) return null;
  if (state === LIMIT_EXCEEDED) {
    return json({ ok: false, error: 'rate_limited' }, { status: 429, origin });
  }
  return json(
    { ok: false, error: 'rate_limiter_unavailable' },
    { status: 503, origin },
  );
}

// P4b: the auth routes get the Worker's own helpers injected — one limiter
// discipline, one JSON shape, one IP reader, and the same fail-closed rules,
// testable end to end without this file.
const authRoutes = createAuthRoutes({
  json,
  readJson,
  clientIp,
  checkRateLimit,
  rateLimitRefusal,
  createDb,
});

async function handleVerify(request, env, origin) {
  // Rate-limit BEFORE touching the password path — this endpoint is a password
  // oracle, so throttle by source IP hard (5 / 60s per colo, see wrangler.jsonc).
  const verifyLimit = rateLimitRefusal(
    await checkRateLimit(env.VERIFY_LIMITER, clientIp(request)),
    origin,
  );
  if (verifyLimit) return verifyLimit;
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }

  const body = await readJson(request);
  const password = body?.password;
  if (typeof password !== 'string' || password.length === 0) {
    return json({ ok: false, error: 'password_required' }, { status: 400, origin });
  }

  const ok = await constantTimeCompareSecrets(password, env.ADMIN_PASSWORD);
  if (!ok) return json({ ok: false, error: 'invalid_password' }, { status: 401, origin });

  const { token, expiresAt } = await signSession(env.ADMIN_SESSION_SECRET);
  return json({ ok: true, token, expiresAt }, { origin });
}

async function handleToken(request, env, origin) {
  if (!env.ADMIN_SESSION_SECRET) {
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }

  // Throttle by IP BEFORE the crypto path. Otherwise anonymous garbage-token
  // spam forces an HMAC verify on every request without ever reaching the
  // limiter — the same reason /api/admin/verify rate-limits first.
  const tokenLimit = rateLimitRefusal(
    await checkRateLimit(env.TOKEN_LIMITER, clientIp(request)),
    origin,
  );
  if (tokenLimit) return tokenLimit;

  // Gate: no valid admin session, no token. A public repo plus an open mint
  // endpoint equals strangers in our rooms burning our GPU.
  const session = await verifySession(env.ADMIN_SESSION_SECRET, request.headers.get('X-Admin-Token'));
  if (!session.valid) return json({ ok: false, error: 'unauthorized' }, { status: 401, origin });

  const body = await readJson(request);
  const room = typeof body?.room === 'string' ? body.room.trim() : '';
  const identity = typeof body?.identity === 'string' ? body.identity.trim() : '';
  if (!room || !identity || room.length > 512 || identity.length > 512) {
    return json({ ok: false, error: 'room_and_identity_required' }, { status: 400, origin });
  }

  try {
    const { token, exp } = await mintLiveKitToken(env, { room, identity });
    return json(
      { ok: true, token, url: env.LIVEKIT_URL ?? null, room, identity, expiresAt: exp },
      { origin },
    );
  } catch {
    return json({ ok: false, error: 'mint_failed' }, { status: 500, origin });
  }
}

// ─── the session layer ─────────────────────────────────────────────────────
//
// One Durable Object instance, addressed by a fixed name. That is the point of
// it: capacity is a single global count, and a count with two authorities is
// not a count. Every /api/session/* request lands on the same object, which is
// what makes "are we full?" answerable when two people press Start at once.
const REGISTRY_NAME = 'global';

// Talk to the registry, or report that we cannot.
//
// Returns null when the binding is missing or the stub throws — the same
// fail-closed posture as checkRateLimit. A deploy that drops the
// `durable_objects` block from wrangler.jsonc must refuse sessions loudly, not
// hand out unbounded rooms with nothing counting them.
async function callRegistry(env, path, body) {
  const ns = env?.SESSION_REGISTRY;
  if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') return null;
  try {
    const stub = ns.get(ns.idFromName(REGISTRY_NAME));
    return await stub.fetch(
      new Request(`https://session-registry.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    );
  } catch (err) {
    console.error('session registry binding failed', err);
    return null;
  }
}

const registryUnavailable = (origin) =>
  json({ ok: false, error: 'session_registry_unavailable' }, { status: 503, origin });

// The gate every /api/session/* route passes first: throttle, then session.
// Rate-limit BEFORE auth for the same reason /api/livekit/token does — an
// unauthenticated flood must be stopped by the cheap check, not the HMAC.
// Returns a Response to refuse with, or null to proceed.
async function sessionGate(request, env, origin) {
  const limit = rateLimitRefusal(
    await checkRateLimit(env.SESSION_LIMITER, clientIp(request)),
    origin,
  );
  if (limit) return limit;

  if (!env.ADMIN_SESSION_SECRET) {
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }
  // REALIGNMENT (CEO, 7 Aug 2026): identity carries authority. Two ways in:
  //
  //   1. A signed-in USER whose account may start sessions — admin role, or
  //      any verified identity (mayStartSession). This is the product path;
  //      the retired admin password's job now lives on real accounts via
  //      the env-only ADMIN_EMAILS bootstrap.
  //   2. The admin token — kept for OPS TOOLING ONLY (probes, drills, the
  //      console): non-browser clients that hold no cookies. It is no
  //      longer the way a person enters the studio.
  //
  // Order matters: the cookie is checked first so a signed-in browser never
  // depends on the ops path.
  const user = await resolveUserSession(request, env, createDb);
  if (user) {
    if (mayStartSession(user)) return null;
    // Signed in but not yet allowed: a DIFFERENT refusal from 401 — the UI
    // must say "verify your email", not "sign in".
    return json({ ok: false, error: 'verification_required' }, { status: 403, origin });
  }
  const session = await verifySession(env.ADMIN_SESSION_SECRET, request.headers.get('X-Admin-Token'));
  if (!session.valid) return json({ ok: false, error: 'unauthorized' }, { status: 401, origin });
  return null;
}

// Map a registry refusal onto an HTTP response. `registry_misconfigured`
// carries the offending variable's name for the log and NOT for the client.
function registryRefusal(payload, origin) {
  if (payload?.error === 'registry_misconfigured') {
    console.error('session registry misconfigured:', payload.detail);
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }
  // Distinct from at_capacity on purpose: "this environment serves no
  // sessions" is a permanent fact a client should stop retrying, while
  // at_capacity is a queue that will clear.
  if (payload?.error === 'sessions_disabled') {
    return json({ ok: false, error: 'sessions_disabled' }, { status: 503, origin });
  }
  if (payload?.error === 'at_capacity') {
    return json(
      {
        ok: false,
        error: 'at_capacity',
        live: payload.live,
        capacity: payload.capacity,
        pool: payload.pool,
      },
      { status: 503, origin },
    );
  }
  return null;
}

async function handleSessionCreate(request, env, origin) {
  const refusal = await sessionGate(request, env, origin);
  if (refusal) return refusal;

  const res = await callRegistry(env, '/create');
  if (!res) return registryUnavailable(origin);
  const created = await res.json().catch(() => null);

  if (!created?.ok) {
    return (
      registryRefusal(created, origin) ??
      json({ ok: false, error: 'session_create_failed' }, { status: 502, origin })
    );
  }

  const { session, endToken } = created;
  // The grant is minted for exactly the lease the registry just issued, so the
  // slot and the credential that can occupy it expire together. `expiresAt` is
  // reported in epoch SECONDS, matching /api/livekit/token; the registry keeps
  // milliseconds internally and this is the only place the two units meet.
  const expiresAt = Math.floor(session.expiresAt / 1000);
  const ttlSeconds = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));

  try {
    const { token } = await mintLiveKitToken(env, {
      room: session.room,
      identity: session.identity,
      ttlSeconds,
    });
    return json(
      {
        ok: true,
        sessionId: session.id,
        endToken,
        room: session.room,
        identity: session.identity,
        token,
        url: env.LIVEKIT_URL ?? null,
        expiresAt,
      },
      { origin },
    );
  } catch {
    // The slot is already allocated at this point. Give it back rather than
    // leaving a room nobody can join holding capacity until its lease runs
    // out. This is the error path, so the extra registry request is not on the
    // budget the O(1) oracle measures.
    await callRegistry(env, '/end', { sessionId: session.id, endToken });
    return json({ ok: false, error: 'mint_failed' }, { status: 500, origin });
  }
}

async function handleSessionEnd(request, env, origin) {
  const refusal = await sessionGate(request, env, origin);
  if (refusal) return refusal;

  const body = await readJson(request);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const endToken = typeof body?.endToken === 'string' ? body.endToken : '';
  if (!sessionId || !endToken) {
    return json({ ok: false, error: 'session_and_token_required' }, { status: 400, origin });
  }

  const res = await callRegistry(env, '/end', { sessionId, endToken });
  if (!res) return registryUnavailable(origin);
  const ended = await res.json().catch(() => null);

  if (!ended?.ok) {
    if (ended?.error === 'end_refused') {
      return json({ ok: false, error: 'end_refused' }, { status: 403, origin });
    }
    return (
      registryRefusal(ended, origin) ??
      json({ ok: false, error: 'session_end_failed' }, { status: 502, origin })
    );
  }
  return json({ ok: true, ended: ended.ended === true, live: ended.live }, { origin });
}

// The operator escape hatch. Releases EVERY slot.
//
// The registry shipped without one, and the first live drill found the cost of
// that: a slot held with no client left to release it, and no way to clear it
// short of waiting out the two-hour lease. A lease is a backstop, not an
// operation.
//
// Blunt on purpose — it cannot tell a stuck slot from a live one, because from
// the server they are identical. Admin-gated and rate-limited like everything
// else here; the caller is someone entitled to evict a session.
async function handleSessionReset(request, env, origin) {
  const refusal = await sessionGate(request, env, origin);
  if (refusal) return refusal;

  const res = await callRegistry(env, '/reset');
  if (!res) return registryUnavailable(origin);
  const reset = await res.json().catch(() => null);
  if (!reset?.ok) {
    return (
      registryRefusal(reset, origin) ??
      json({ ok: false, error: 'session_reset_failed' }, { status: 502, origin })
    );
  }
  console.warn('session registry reset — released', reset.released, 'slot(s)');
  return json({ ok: true, released: reset.released }, { origin });
}

async function handleSessionCapacity(request, env, origin) {
  const refusal = await sessionGate(request, env, origin);
  if (refusal) return refusal;

  const res = await callRegistry(env, '/capacity');
  if (!res) return registryUnavailable(origin);
  const capacity = await res.json().catch(() => null);
  if (!capacity?.ok) {
    return (
      registryRefusal(capacity, origin) ??
      json({ ok: false, error: 'capacity_read_failed' }, { status: 502, origin })
    );
  }

  // The one endpoint in the API that invites polling, so it is the one that
  // gets a cache header. This is an admin-console read, not something the lens
  // does — the lens is told its room once, at create (ROADMAP.md §P1 rule 1).
  // Five seconds of browser caching means even a naive per-second poll reaches
  // the Durable Object at a fifth of the rate.
  //
  // `private` because the route is authenticated by X-Admin-Token and that
  // header is not in Vary — a shared cache would otherwise be free to key the
  // entry on the URL alone and hand one caller's response to another. The
  // intent was always the browser's own cache; this says so.
  return json(
    {
      ok: true,
      enabled: capacity.enabled,
      live: capacity.live,
      capacity: capacity.capacity,
      available: capacity.available,
      pool: capacity.pool,
    },
    { status: 200, origin, headers: { 'Cache-Control': 'private, max-age=5' } },
  );
}

// ─── the video spend wall ───────────────────────────────────────────────────
//
// One SpendLedger instance, one name, for the same reason the registry has
// one: a budget with two authorities is not a budget. Same fail-closed
// posture — a deploy that drops the binding refuses video rather than serving
// it unmetered, because an unmetered vendor is the named disaster here.
const LEDGER_NAME = 'global';

async function callLedger(env, path, body) {
  const ns = env?.VIDEO_LEDGER;
  if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') return null;
  try {
    const stub = ns.get(ns.idFromName(LEDGER_NAME));
    return await stub.fetch(
      new Request(`https://spend-ledger.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    );
  } catch (err) {
    console.error('spend ledger binding failed', err);
    return null;
  }
}

const ledgerUnavailable = (origin) =>
  json({ ok: false, error: 'video_ledger_unavailable' }, { status: 503, origin });

// Rate-limit BEFORE auth, like every other route family here.
async function videoGate(request, env, origin) {
  const limit = rateLimitRefusal(
    await checkRateLimit(env.VIDEO_LIMITER, clientIp(request)),
    origin,
  );
  if (limit) return limit;
  if (!env.ADMIN_SESSION_SECRET) {
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }
  // Same two doors as the session gate (realignment): the video leg belongs
  // to the same person the audio leg does — a signed-in user who may start,
  // or the ops token. Split gates with different doors would strand a
  // signed-in user with voice but no face.
  const user = await resolveUserSession(request, env, createDb);
  if (user) {
    if (mayStartSession(user)) return null;
    return json({ ok: false, error: 'verification_required' }, { status: 403, origin });
  }
  const session = await verifySession(env.ADMIN_SESSION_SECRET, request.headers.get('X-Admin-Token'));
  if (!session.valid) return json({ ok: false, error: 'unauthorized' }, { status: 401, origin });
  return null;
}

// Ledger refusals → HTTP, each distinct so a client can say something true.
// video_budget_exhausted is the wall WORKING, not an outage; video_disabled is
// a kill switch; misconfiguration logs the detail and never echoes it.
function ledgerRefusal(payload, origin) {
  if (payload?.error === 'ledger_misconfigured') {
    console.error('spend ledger misconfigured:', payload.detail);
    return json({ ok: false, error: 'server_misconfigured' }, { status: 500, origin });
  }
  if (payload?.error === 'video_disabled') {
    return json({ ok: false, error: 'video_disabled' }, { status: 503, origin });
  }
  if (payload?.error === 'video_budget_exhausted') {
    return json(
      {
        ok: false,
        error: 'video_budget_exhausted',
        spentSeconds: payload.spentSeconds,
        totalSeconds: payload.totalSeconds,
      },
      { status: 503, origin },
    );
  }
  if (payload?.error === 'settle_refused') {
    return json({ ok: false, error: 'settle_refused' }, { status: 403, origin });
  }
  return null;
}

async function handleVideoReserve(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  const body = await readJson(request);
  const res = await callLedger(env, '/reserve', {
    requestedSeconds: body?.requestedSeconds,
  });
  if (!res) return ledgerUnavailable(origin);
  const out = await res.json().catch(() => null);
  if (!out?.ok) {
    return ledgerRefusal(out, origin) ?? json({ ok: false, error: 'reserve_failed' }, { status: 502, origin });
  }
  return json(out, { origin });
}

async function handleVideoSettle(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  const body = await readJson(request);
  const reservationId = typeof body?.reservationId === 'string' ? body.reservationId.trim() : '';
  const settleToken = typeof body?.settleToken === 'string' ? body.settleToken : '';
  if (!reservationId || !settleToken) {
    return json({ ok: false, error: 'reservation_and_token_required' }, { status: 400, origin });
  }
  const res = await callLedger(env, '/settle', {
    reservationId,
    settleToken,
    usedSeconds: body?.usedSeconds,
  });
  if (!res) return ledgerUnavailable(origin);
  const out = await res.json().catch(() => null);
  if (!out?.ok) {
    return ledgerRefusal(out, origin) ?? json({ ok: false, error: 'settle_failed' }, { status: 502, origin });
  }
  return json(out, { origin });
}

// ─── the reserve-bound client token (P2b) ───────────────────────────────────
//
// ONE handler does reserve AND mint, which is how the canon's binding rule is
// satisfied atomically: a token can only ever be minted in the same request
// that created its reservation, so "duplicate or concurrent issuance for the
// same reservation" is not refused — it is unrepresentable. There is no
// re-mint endpoint on purpose.
//
// The vendor call is the project's first, so its posture is worth stating:
// the raw key lives ONLY in env.DECART_API_KEY (wrangler secret, the CEO's
// hands); what returns to the browser is Decart's short-lived client token,
// constrained to maxSessionDuration = the granted seconds — wall #2, whose
// runtime bite the probe measures.
const DECART_API_BASE = 'https://api.decart.ai';

async function mintDecartClientToken(env, { grantedSeconds, reservationId }) {
  const res = await fetch(`${env.DECART_API_BASE ?? DECART_API_BASE}/v1/client/tokens`, {
    method: 'POST',
    // A vendor that hangs must not hang us. The hold is taken BEFORE this
    // call (reserve → mint), so a stalled vendor would strand the hold until
    // the caller's own fetch gave up. Ten seconds, then the catch path in
    // handleVideoToken settles the hold back at zero use.
    signal: AbortSignal.timeout(10_000),
    headers: { 'x-api-key': env.DECART_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // The token IS the session's control credential for its whole life —
      // Decart accepts session control (ICE PATCH, prompt, DELETE) only from
      // the token that created the session (verified live 3 Aug 2026; the
      // raw key answers 401). So it must outlive the grant by enough for the
      // settle path and the executioner's bounded retries: a token that
      // expires mid-session leaves a stop that cannot stop.
      expiresIn: grantedSeconds + 300,
      constraints: { realtime: { maxSessionDuration: grantedSeconds } },
      metadata: { reservationId },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.apiKey) {
    throw new Error(`decart token mint failed: HTTP ${res.status}`);
  }
  return { clientToken: body.apiKey, expiresAt: body.expiresAt ?? null };
}

async function handleVideoToken(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;

  // Fail closed BEFORE reserving: no vendor key, no hold taken.
  if (!env.DECART_API_KEY) {
    return json({ ok: false, error: 'video_vendor_unconfigured' }, { status: 503, origin });
  }

  const body = await readJson(request);
  const res = await callLedger(env, '/reserve', { requestedSeconds: body?.requestedSeconds });
  if (!res) return ledgerUnavailable(origin);
  const reserved = await res.json().catch(() => null);
  if (!reserved?.ok) {
    return (
      ledgerRefusal(reserved, origin) ??
      json({ ok: false, error: 'reserve_failed' }, { status: 502, origin })
    );
  }

  try {
    const minted = await mintDecartClientToken(env, {
      grantedSeconds: reserved.grantedSeconds,
      reservationId: reserved.reservationId,
    });
    return json(
      {
        ok: true,
        clientToken: minted.clientToken,
        clientTokenExpiresAt: minted.expiresAt,
        reservationId: reserved.reservationId,
        settleToken: reserved.settleToken,
        grantedSeconds: reserved.grantedSeconds,
        remainingSeconds: reserved.remainingSeconds,
      },
      { origin },
    );
  } catch (err) {
    // The hold is already taken. Give it back rather than letting a vendor
    // hiccup burn budget nobody used — the session-create mint_failed rule,
    // applied to money. This is the error path, off the oracle's budget.
    console.error('decart mint failed after reserve', err);
    await callLedger(env, '/settle', {
      reservationId: reserved.reservationId,
      settleToken: reserved.settleToken,
      usedSeconds: 0,
    });
    return json({ ok: false, error: 'vendor_mint_failed' }, { status: 502, origin });
  }
}

// ─── the white-label session (P2c: the committed topology) ─────────────────
//
// The Worker creates and controls every Decart session; media flows
// browser↔Decart directly. The raw key never leaves this file's env — and
// neither does the constrained client token it mints for itself: wall #2
// rides on the session because the Worker CREATES the session with a token it
// never shows anyone.
//
// Browser-side session control (ICE, prompt, end) authenticates with a
// STATELESS control token — HMAC over {sid, rid, exp} with the admin session
// secret — so an ICE candidate costs zero Durable Object requests. The O(1)
// budget for a video session stays: reserve(1) + bind(1) + settle(1).

// The purpose label for sealing the vendor client token into the control
// token. The browser carries the ciphertext (it must — control ops cost zero
// Durable Object reads precisely because the token is stateless), but only
// this Worker's secret can open it, so the constrained vendor token still
// never leaves the server in USABLE form.
const VENDOR_TOKEN_SEAL = 'video-vendor-token';

async function signControlToken(env, { sid, rid, ttlSeconds, vendorToken }) {
  const payload = {
    sub: 'video-session',
    sid,
    rid,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(vendorToken ? { vtk: await seal(env.ADMIN_SESSION_SECRET, VENDOR_TOKEN_SEAL, vendorToken) } : {}),
  };
  const payloadB64 = base64UrlEncodeJson(payload);
  const sig = await hmacSha256(env.ADMIN_SESSION_SECRET, `video.${payloadB64}`);
  return `${payloadB64}.${base64UrlEncode(sig)}`;
}

async function verifyControlToken(env, token, sid) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  let provided;
  try {
    provided = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  const expected = await hmacSha256(env.ADMIN_SESSION_SECRET, `video.${payloadB64}`);
  if (!timingSafeEqual(expected, provided)) return null;
  let payload;
  try {
    payload = decodeJson(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
  if (payload.sub !== 'video-session') return null;
  if (payload.sid !== sid) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function decartFetch(env, path, init) {
  return fetch(`${env.DECART_API_BASE ?? DECART_API_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { 'x-api-key': env.DECART_API_KEY, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

// The reference avatar (CEO directive, 3 Aug 2026): a static image whose
// identity Lucy animates with the live camera feed. Decart takes it as
// `image_data` — base64, JPEG/PNG/WebP, "keep under 5MB". The browser sends a
// data URL or bare base64; both are normalized here, and anything oversized
// or non-base64 is refused BEFORE a reservation exists, so a bad upload can
// never cost a hold.
const MAX_IMAGE_B64_CHARS = 7_000_000; // ≈ 5 MB decoded

// Lucy generates NOTHING on a session with no prompt and no reference image —
// transport connects, ICE completes, the SSE stays silent, and the screen is
// blank. Measured live 3 Aug 2026: promptless create → zero frames in 40s;
// the same create with any prompt → frames in under 10s. This was the CEO's
// blank drill after every other layer was fixed. A session the ledger is
// paying for must always have work to do, so a create with neither gets the
// lens's neutral default: the same person, faithfully.
const DEFAULT_VIDEO_PROMPT = 'the same person, photorealistic, natural colors, true to life';

function normalizeReferenceImage(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const b64 = raw.startsWith('data:') ? (raw.split(',', 2)[1] ?? '') : raw;
  if (!b64 || b64.length > MAX_IMAGE_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) return null;
  return b64;
}

async function handleVideoSession(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  if (!env.DECART_API_KEY) {
    return json({ ok: false, error: 'video_vendor_unconfigured' }, { status: 503, origin });
  }

  const body = await readJson(request);
  const sdpOffer = typeof body?.sdpOffer === 'string' ? body.sdpOffer : '';
  if (!sdpOffer) return json({ ok: false, error: 'sdp_offer_required' }, { status: 400, origin });
  const imageData = normalizeReferenceImage(body?.imageData);
  if (body?.imageData && !imageData) {
    return json({ ok: false, error: 'image_invalid' }, { status: 400, origin });
  }

  // 1. The durable intent: the reservation exists before Decart hears a word
  //    (the canon's pending-create marker IS the unbound reservation).
  const res = await callLedger(env, '/reserve', { requestedSeconds: body?.requestedSeconds });
  if (!res) return ledgerUnavailable(origin);
  const reserved = await res.json().catch(() => null);
  if (!reserved?.ok) {
    return ledgerRefusal(reserved, origin) ?? json({ ok: false, error: 'reserve_failed' }, { status: 502, origin });
  }

  let decartSessionId = null;
  // Hoisted so the compensation path can present the CREATING token to the
  // vendor — the only credential Decart accepts for session control.
  let mintedToken = null;
  try {
    // 2. Wall #2: a constrained client token, minted for the WORKER's own use.
    const minted = await mintDecartClientToken(env, {
      grantedSeconds: reserved.grantedSeconds,
      reservationId: reserved.reservationId,
    });
    mintedToken = minted.clientToken;

    // 3. The session, created server-side with the constrained token.
    //
    // The wire shapes here are DECART'S, verified against the live API on
    // 3 Aug 2026 after the first real create failed with exactly this
    // handler's invented field names ("body.sdp: Field required"): the offer
    // travels as an RTCSessionDescription-shaped object, the response is
    // snake_case (`session_id`, answer at `sdp.sdp`), and the ICE ETag is a
    // response HEADER, not a body field.
    const createRes = await fetch(`${env.DECART_API_BASE ?? DECART_API_BASE}/v1/realtime/sessions`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'x-api-key': minted.clientToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'lucy-2.5',
        sdp: { type: 'offer', sdp: sdpOffer },
        // The user's prompt wins; a reference image is work in itself; a
        // session with NEITHER gets the neutral default — a promptless
        // session generates nothing and bills anyway (see DEFAULT_VIDEO_PROMPT).
        ...(typeof body?.prompt === 'string' && body.prompt
          ? { prompt: body.prompt }
          : imageData
            ? {}
            : { prompt: DEFAULT_VIDEO_PROMPT }),
        ...(imageData ? { image_data: imageData } : {}),
      }),
    });
    const created = await createRes.json().catch(() => null);
    if (!createRes.ok || !created) {
      const detail = created?.detail ?? created?.title ?? '';
      // The vendor's own broke-account signal (422 "Insufficient credits",
      // seen live 3 Aug 2026 when the Decart balance ran dry) must surface AS
      // ITSELF — it reached the CEO as a mystery 502 and read as a proxy bug.
      // Money problems are named, never generic.
      if (createRes.status === 422 && /insufficient credits/i.test(detail)) {
        const err = /** @type {Error & {vendorCredits?: boolean}} */ (
          new Error('vendor account out of credits')
        );
        err.vendorCredits = true;
        throw err;
      }
      throw new Error(`vendor session create failed: HTTP ${createRes.status}${detail ? ` — ${detail}` : ''}`);
    }
    decartSessionId = created.session_id ?? null;
    if (!decartSessionId) throw new Error('vendor session create returned no id');
    // The If-Match seed for every ICE PATCH this session will ever send. A
    // create without one would bind a PAID session that can never deliver a
    // candidate — fail closed here, while the compensation path can still
    // kill it and return the hold.
    const vendorEtag = createRes.headers.get('etag');
    if (!vendorEtag) throw new Error('vendor session create returned no ETag');

    // 4. The executioner's ammunition — target AND credential — persisted
    //    BEFORE anything reaches the browser. A failed bind compensates
    //    immediately with the id in hand.
    const bindRes = await callLedger(env, '/bind', {
      reservationId: reserved.reservationId,
      decartSessionId,
      vendorToken: mintedToken,
    });
    const bound = bindRes ? await bindRes.json().catch(() => null) : null;
    if (!bound?.ok) throw new Error('bind failed');

    // 5. Only now: the browser's share. Control token scoped to this session,
    //    valid for the lease, carrying the vendor token SEALED (the browser
    //    transports it; only this Worker can open it); Decart's own event
    //    token for the direct SSE.
    const controlToken = await signControlToken(env, {
      sid: decartSessionId,
      rid: reserved.reservationId,
      ttlSeconds: reserved.grantedSeconds + 300,
      vendorToken: mintedToken,
    });

    return json(
      {
        ok: true,
        sessionId: decartSessionId,
        controlToken,
        grantedSeconds: reserved.grantedSeconds,
        remainingSeconds: reserved.remainingSeconds,
        // Vendor payload passthrough — answer SDP (`sdp.sdp`), ICE servers,
        // SSE auth (`events`) — plus the ETag lifted from the header, because
        // a passthrough of the body alone would silently drop the one value
        // every subsequent ICE PATCH is required to present.
        vendor: { ...created, etag: vendorEtag },
      },
      { origin },
    );
  } catch (err) {
    console.error('white-label session create failed', err);
    // Compensating DELETE with the id in hand — and its RESULT decides what
    // the money does. Refunding a session that may still be running would pay
    // for someone else's stream: a failed kill settles FULLY SPENT and logs
    // the orphan, because the ledger record is about to be destroyed either
    // way and this is the last moment anyone can account for it.
    let killed = decartSessionId === null; // nothing to kill = nothing running
    if (decartSessionId) {
      const delRes = await decartFetch(env, `/v1/realtime/sessions/${decartSessionId}`, {
        method: 'DELETE',
        // The creating token, or nothing works: the raw key answers 401 here.
        headers: { 'x-api-key': mintedToken },
      }).catch(() => null);
      killed = Boolean(delRes && (delRes.ok || delRes.status === 404));
      if (!killed) {
        console.error(
          'ORPHAN: vendor session survived its compensating delete',
          JSON.stringify({ decartSessionId, reservationId: reserved.reservationId }),
        );
      }
    }
    await callLedger(env, '/settle', {
      reservationId: reserved.reservationId,
      settleToken: reserved.settleToken,
      usedSeconds: killed ? 0 : reserved.grantedSeconds,
    });
    if (/** @type {any} */ (err)?.vendorCredits) {
      // 402: the true condition. Only the CEO's hands can fix this one.
      return json({ ok: false, error: 'vendor_credits_exhausted' }, { status: 402, origin });
    }
    return json(
      { ok: false, error: killed ? 'vendor_session_failed' : 'vendor_session_orphaned' },
      { status: 502, origin },
    );
  }
}

// Control-plane proxy: ICE candidates and prompt updates. Zero ledger cost —
// the control token is verified statelessly.
async function handleVideoSessionControl(request, env, origin, sid, action) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  const body = await readJson(request);
  const payload = await verifyControlToken(env, body?.controlToken, sid);
  if (!payload) return json({ ok: false, error: 'control_refused' }, { status: 403, origin });

  // The session's creating client token, unsealed from the control token the
  // browser transported. Decart accepts session control from NO other
  // credential (raw key → 401, verified live 3 Aug 2026). The HMAC was
  // checked above, so the ciphertext is exactly what this Worker sealed; a
  // payload without one (pre-seal token) falls back to the raw key and fails
  // at the vendor the way it always did.
  const vendorKey = payload.vtk
    ? await unseal(env.ADMIN_SESSION_SECRET, VENDOR_TOKEN_SEAL, payload.vtk)
    : null;
  const vendorAuth = { 'x-api-key': vendorKey ?? env.DECART_API_KEY };

  if (action === 'candidates') {
    // Decart's contract (signaling-proxy-http, verified 3 Aug 2026): If-Match
    // is REQUIRED and the ETag ROTATES — each PATCH answers 204 No Content
    // with the next ETag in its header. The rotated value is returned to the
    // browser so the negotiator can chain it into the next send; a stale one
    // earns a 412 from the vendor, not a guess from us.
    const res = await decartFetch(env, `/v1/realtime/sessions/${sid}`, {
      method: 'PATCH',
      headers: { ...vendorAuth, ...(body?.etag ? { 'If-Match': body.etag } : {}) },
      body: JSON.stringify({ candidates: body?.candidates ?? null }),
    }).catch(() => null);
    if (!res) return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
    const out = await res.json().catch(() => ({}));
    return json(
      { ok: res.ok, status: res.status, etag: res.headers.get('etag'), vendor: out },
      { status: res.ok ? 200 : 502, origin },
    );
  }

  if (action === 'prompt') {
    const res = await decartFetch(env, `/v1/realtime/sessions/${sid}/prompt`, {
      method: 'POST',
      headers: vendorAuth,
      body: JSON.stringify({ prompt: body?.prompt ?? '' }),
    }).catch(() => null);
    if (!res) return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
    const out = await res.json().catch(() => ({}));
    return json({ ok: res.ok, status: res.status, vendor: out }, { status: res.ok ? 200 : 502, origin });
  }

  if (action === 'image') {
    // Mid-session identity swap — Decart allows changing the reference image
    // without reconnecting. Same normalization as create: a bad image is a
    // 400 here, never a byte to the vendor.
    const imageData = normalizeReferenceImage(body?.imageData);
    if (!imageData) return json({ ok: false, error: 'image_invalid' }, { status: 400, origin });
    const res = await decartFetch(env, `/v1/realtime/sessions/${sid}/image`, {
      method: 'POST',
      headers: vendorAuth,
      body: JSON.stringify({
        image_data: imageData,
        ...(typeof body?.prompt === 'string' && body.prompt ? { prompt: body.prompt } : {}),
      }),
    }).catch(() => null);
    if (!res) return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
    const out = await res.json().catch(() => ({}));
    return json({ ok: res.ok, status: res.status, vendor: out }, { status: res.ok ? 200 : 502, origin });
  }

  if (action === 'end') {
    // The vendor-truth exchange, server-to-server: WE delete, WE read the
    // summary, and the ledger hears OUR copy of Decart's answer — never the
    // browser's opinion of it.
    const res = await decartFetch(env, `/v1/realtime/sessions/${sid}`, {
      method: 'DELETE',
      headers: vendorAuth,
    }).catch(() => null);
    const killed = Boolean(res && (res.ok || res.status === 404));

    // A FAILED kill must not settle. Settling deletes the reservation, and
    // the reservation is the executioner's ammunition — destroying it here
    // would leave a running vendor session with no server-side owner, which
    // is precisely the orphan this whole ordering exists to prevent. Leave
    // the record; the alarm inherits the kill with its bounded retries.
    if (!killed) {
      console.error(
        'end: vendor delete failed — deferring to the executioner',
        JSON.stringify({ decartSessionId: sid, status: res?.status ?? null }),
      );
      return json(
        { ok: false, error: 'vendor_delete_failed', vendorDeleteStatus: res?.status ?? null },
        { status: 502, origin },
      );
    }

    const summary = await res.json().catch(() => null);
    const settleRes = await callLedger(env, '/settle-by-session', {
      decartSessionId: sid,
      vendorSummary: summary,
    });
    if (!settleRes) return ledgerUnavailable(origin);
    const settled = await settleRes.json().catch(() => null);
    if (!settled?.ok) {
      return json({ ok: false, error: 'session_end_failed' }, { status: 502, origin });
    }
    return json({ ok: true, ...settled, vendorDeleteStatus: res.status }, { origin });
  }

  return json({ ok: false, error: 'not_found' }, { status: 404, origin });
}

async function handleVideoBudget(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  const res = await callLedger(env, '/budget');
  if (!res) return ledgerUnavailable(origin);
  const out = await res.json().catch(() => null);
  if (!out?.ok) {
    return ledgerRefusal(out, origin) ?? json({ ok: false, error: 'budget_read_failed' }, { status: 502, origin });
  }
  return json(out, { status: 200, origin, headers: { 'Cache-Control': 'private, max-age=5' } });
}

async function handleVideoReset(request, env, origin) {
  const refusal = await videoGate(request, env, origin);
  if (refusal) return refusal;
  const res = await callLedger(env, '/reset');
  if (!res) return ledgerUnavailable(origin);
  const out = await res.json().catch(() => null);
  if (!out?.ok) {
    return ledgerRefusal(out, origin) ?? json({ ok: false, error: 'video_reset_failed' }, { status: 502, origin });
  }
  console.warn('spend ledger reset — released', out.released, 'reservation(s), meter zeroed');
  return json(out, { origin });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return handlePreflight(request);

    const { pathname } = new URL(request.url);

    if (pathname === '/api/health') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return json({ ok: true, version: VERSION }, { origin });
    }

    if (pathname === '/api/admin/verify') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleVerify(request, env, origin);
    }

    // ── P4b: accounts. Cookie sessions, origin-gated, rate-limited hard. ──
    if (pathname.startsWith('/api/auth/') || pathname === '/api/me/profile') {
      const method = request.method;
      if (pathname === '/api/auth/signup' && method === 'POST') {
        return authRoutes.signup(request, env, origin);
      }
      if (pathname === '/api/auth/signin' && method === 'POST') {
        return authRoutes.signin(request, env, origin);
      }
      if (pathname === '/api/auth/signout' && method === 'POST') {
        return authRoutes.signout(request, env, origin);
      }
      if (pathname === '/api/auth/me' && method === 'GET') {
        return authRoutes.me(request, env, origin);
      }
      if (pathname === '/api/auth/config' && method === 'GET') {
        return authRoutes.config(request, env, origin);
      }
      if (pathname === '/api/auth/verify' && method === 'GET') {
        return authRoutes.verifyEmail(request, env, origin);
      }
      if (pathname === '/api/auth/resend-verification' && method === 'POST') {
        return authRoutes.resendVerification(request, env, origin);
      }
      if (pathname === '/api/auth/google' && method === 'GET') {
        return authRoutes.googleStart(request, env, origin);
      }
      if (pathname === '/api/auth/google/callback' && method === 'GET') {
        return authRoutes.googleCallback(request, env, origin);
      }
      if (pathname === '/api/me/profile' && method === 'PUT') {
        return authRoutes.putProfile(request, env, origin);
      }
      return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
    }

    if (pathname === '/api/livekit/token') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleToken(request, env, origin);
    }

    if (pathname.startsWith('/api/video/')) {
      const wrongMethod =
        (pathname === '/api/video/budget' && request.method !== 'GET') ||
        (pathname !== '/api/video/budget' && request.method !== 'POST');
      // Everything video is POST except the budget read; the vendor-side PATCH
      // for ICE happens inside the Worker, not on our surface.
      if (wrongMethod) {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      if (pathname === '/api/video/token') return handleVideoToken(request, env, origin);
      if (pathname === '/api/video/session') return handleVideoSession(request, env, origin);
      {
        const m = pathname.match(
          /^\/api\/video\/session\/([A-Za-z0-9_-]{1,128})\/(candidates|prompt|image|end)$/,
        );
        if (m) return handleVideoSessionControl(request, env, origin, m[1], m[2]);
      }
      if (pathname === '/api/video/reserve') return handleVideoReserve(request, env, origin);
      if (pathname === '/api/video/settle') return handleVideoSettle(request, env, origin);
      if (pathname === '/api/video/budget') return handleVideoBudget(request, env, origin);
      if (pathname === '/api/video/reset') return handleVideoReset(request, env, origin);
      return json({ ok: false, error: 'not_found' }, { status: 404, origin });
    }

    if (pathname === '/api/session/create') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleSessionCreate(request, env, origin);
    }

    if (pathname === '/api/session/end') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleSessionEnd(request, env, origin);
    }

    if (pathname === '/api/session/reset') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleSessionReset(request, env, origin);
    }

    if (pathname === '/api/session/capacity') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleSessionCapacity(request, env, origin);
    }

    return json({ ok: false, error: 'not_found' }, { status: 404, origin });
  },
};

// Re-exported because a Durable Object class must be reachable from the
// Worker's entrypoint — that is how the runtime resolves `class_name` in the
// wrangler.jsonc binding and how the migration finds it.
export { VERSION, SessionRegistry, SpendLedger };
