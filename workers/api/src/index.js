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
import { mintLiveKitToken } from './livekit.js';
import { SessionRegistry } from './sessionRegistry.js';

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

    if (pathname === '/api/livekit/token') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'method_not_allowed' }, { status: 405, origin });
      }
      return handleToken(request, env, origin);
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
export { VERSION, SessionRegistry };
