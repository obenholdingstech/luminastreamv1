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

// Returns true when the request should be rejected as over-limit. When the
// binding is absent (pure `node --test`, or a misconfigured deploy) we fail
// OPEN rather than brick the endpoint — the binding is declared in
// wrangler.jsonc, so it is always present in `wrangler dev` and production.
async function isRateLimited(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

async function handleVerify(request, env, origin) {
  // Rate-limit BEFORE touching the password path — this endpoint is a password
  // oracle, so throttle by source IP hard (5 / 60s per colo, see wrangler.jsonc).
  if (await isRateLimited(env.VERIFY_LIMITER, clientIp(request))) {
    return json({ ok: false, error: 'rate_limited' }, { status: 429, origin });
  }
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
  if (await isRateLimited(env.TOKEN_LIMITER, clientIp(request))) {
    return json({ ok: false, error: 'rate_limited' }, { status: 429, origin });
  }

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
