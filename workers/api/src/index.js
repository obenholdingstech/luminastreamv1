// LuminaStream API Worker — our first owned backend.
//
//   GET  /api/health         → { ok, version }                (public)
//   POST /api/admin/verify   → { password } → { ok, token }   (rate-limited hard)
//   POST /api/livekit/token  → { room, identity } → LiveKit access token
//                              (requires a valid X-Admin-Token, rate-limited)
//
// This is the path real users will eventually take, replacing the DEV-ONLY
// `scripts/generate-livekit-token.js`. The LiveKit API secret lives ONLY in
// the Worker env (wrangler secret put) and never reaches the browser.

import { handlePreflight, corsHeaders } from './cors.js';
import { constantTimeCompareSecrets } from './crypto.js';
import { signSession, verifySession } from './session.js';
import { mintLiveKitToken } from './livekit.js';

const VERSION = '0.1.0';

function json(body, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
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

    return json({ ok: false, error: 'not_found' }, { status: 404, origin });
  },
};

export { VERSION };
