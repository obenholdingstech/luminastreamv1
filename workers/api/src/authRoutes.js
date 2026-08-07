// P4b — the auth endpoints. Every handler follows the house shape: rate
// limit BEFORE any database work (limit-before-auth), fail closed, and one
// uniform failure per surface:
//
//   POST /api/auth/signup   { email, password, displayName? }
//   POST /api/auth/signin   { email, password }
//   POST /api/auth/signout  (cookie)
//   GET  /api/auth/me       (cookie) → { user, profile }
//   PUT  /api/me/profile    (cookie) { voiceId?, voiceName?, stylePrompt?, videoPathMs? }
//
// Security decisions, written where they live:
// * CSRF: cookie-authed state changes reject any PRESENT Origin outside the
//   trusted-for-credentials tier (allowed AND https — localhost excluded).
//   A cross-site attacker's browser always sends its Origin; a non-browser
//   client that never auto-attaches cookies sends none — absent is fine,
//   foreign is refused.
// * Enumeration: sign-in answers `invalid_credentials` for a missing account
//   and a wrong password alike, and the missing-account path verifies
//   against a dummy hash so both cost the same KDF time. Sign-up necessarily
//   reveals existence (409) — rate-limited hard; verification email closes
//   the gap when email infra lands.
// * Stuffing: sign-in burns TWO limiter keys — per-IP and per-(IP+account)
//   pair — capping each source's guesses at an account without handing
//   anyone who knows the email a lockout lever against its owner.

import {
  LAST_SEEN_THROTTLE_SECONDS,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  dummyPasswordHash,
  hashPassword,
  isPlausibleEmail,
  newSessionToken,
  normalizeEmail,
  passwordPolicyError,
  readSessionCookie,
  sessionCookie,
  sessionTokenHash,
  verifyPassword,
} from './auth.js';
import { isTrustedForCredentials } from './cors.js';
import { base64UrlEncode, sha256 } from './crypto.js';
import { resolveUserSession } from './userSession.js';

/**
 * @param {{
 *   json: Function, readJson: Function, clientIp: Function,
 *   checkRateLimit: Function, rateLimitRefusal: Function,
 *   createDb: Function,
 * }} kit — the Worker's own helpers, injected so tests own every edge.
 */
export function createAuthRoutes(kit) {
  const { json, readJson, clientIp, checkRateLimit, rateLimitRefusal, createDb } = kit;

  const db = (env) => createDb(env.IDENTITY_DB);

  // CSRF wall for cookie-authed and account-mutating routes: a PRESENT
  // Origin must be in the TRUSTED-for-credentials tier (allowed AND https —
  // localhost is deliberately excluded, see cors.js); absent (curl, native
  // apps) is acceptable because those clients never auto-attach a victim's
  // cookie.
  const foreignOrigin = (request, origin) => {
    const header = request.headers.get('Origin');
    if (header && !isTrustedForCredentials(header)) {
      return json({ ok: false, error: 'origin_not_allowed' }, { status: 403, origin });
    }
    return null;
  };

  const limited = async (env, origin, key) =>
    rateLimitRefusal(await checkRateLimit(env.AUTH_LIMITER, key), origin);

  /** Mint a session, store its HASH, answer with the cookie. */
  const startSession = async (dbi, userId, body, origin) => {
    const token = newSessionToken();
    await dbi.createAuthSession({
      tokenHash: await sessionTokenHash(token),
      userId,
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    return json(body, { origin, headers: { 'Set-Cookie': sessionCookie(token) } });
  };

  // ONE resolver for the whole Worker (userSession.js) — the auth routes
  // and the session gate must never disagree about who a request is.
  const resolveSession = (request, env) => resolveUserSession(request, env, createDb);

  // The ADMIN_EMAILS bootstrap (realignment, 7 Aug 2026): authority comes
  // from the env-only allowlist, granted at sign-in/sign-up on a REAL
  // account — the retired admin password's successor. Env-only means the
  // public repo never names an admin; an empty/absent variable grants
  // nobody.
  const adminEmails = (env) =>
    String(env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

  const bootstrapAdmin = async (env, dbi, userId, email) => {
    if (adminEmails(env).includes(email)) await dbi.setRole(userId, 'admin');
  };

  return {
    async signup(request, env, origin) {
      const foreign = foreignOrigin(request, origin);
      if (foreign) return foreign;
      const refusal = await limited(env, origin, `signup:${clientIp(request)}`);
      if (refusal) return refusal;

      const body = await readJson(request);
      const email = normalizeEmail(body?.email);
      if (!isPlausibleEmail(email)) {
        return json({ ok: false, error: 'email_invalid' }, { status: 400, origin });
      }
      const policyError = passwordPolicyError(body?.password);
      if (policyError) return json({ ok: false, error: policyError }, { status: 400, origin });
      const displayName =
        typeof body?.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim().slice(0, 80)
          : null;

      const dbi = db(env);
      let userId;
      try {
        ({ userId } = await dbi.createUserWithIdentity({
          provider: 'password',
          subject: email,
          passwordHash: await hashPassword(body.password),
          displayName,
        }));
      } catch (err) {
        // D1 surfaces the UNIQUE(provider, subject) violation here — the one
        // place sign-up admits an account exists. Anything else is a 500.
        if (/UNIQUE/i.test(String(err?.message ?? err))) {
          return json({ ok: false, error: 'email_in_use' }, { status: 409, origin });
        }
        console.error('signup failed', err);
        return json({ ok: false, error: 'signup_failed' }, { status: 500, origin });
      }
      await bootstrapAdmin(env, dbi, userId, email);
      return startSession(dbi, userId, { ok: true, user: { id: userId, displayName } }, origin);
    },

    async signin(request, env, origin) {
      const foreign = foreignOrigin(request, origin);
      if (foreign) return foreign;
      const body = await readJson(request);
      const email = normalizeEmail(body?.email);
      // TWO keys, both burned before any lookup: per-IP (one machine, many
      // accounts) and per-(IP+account) PAIR. The pair — not the bare account
      // — is deliberate (CodeRabbit, PR 85): a bare per-account key lets
      // anyone who knows a victim's email spend the victim's budget and hold
      // their sign-in at 429 forever. The pair key caps each source at 10
      // guesses/min against a given account while the owner's own budget
      // stays untouchable; the KDF cost is what makes that guess rate
      // worthless.
      const ip = clientIp(request);
      const ipRefusal = await limited(env, origin, `signin:ip:${ip}`);
      if (ipRefusal) return ipRefusal;
      const pairKey = base64UrlEncode(await sha256(`signin:${ip}|${email}`)).slice(0, 32);
      const pairRefusal = await limited(env, origin, `signin:pair:${pairKey}`);
      if (pairRefusal) return pairRefusal;

      const uniformRefusal = () =>
        json({ ok: false, error: 'invalid_credentials' }, { status: 401, origin });
      if (!isPlausibleEmail(email) || typeof body?.password !== 'string') {
        return uniformRefusal();
      }

      const dbi = db(env);
      await dbi.deleteExpiredAuthSessions(); // opportunistic hygiene, bounded
      const identity = await dbi.findIdentity('password', email);
      if (!identity || !identity.passwordHash) {
        // Same KDF cost as the found path — absence must not be faster.
        await verifyPassword(body.password, await dummyPasswordHash());
        return uniformRefusal();
      }
      const verdict = await verifyPassword(body.password, identity.passwordHash);
      if (!verdict.ok) return uniformRefusal();
      if (verdict.needsRehash) {
        // The fleet strengthens on sign-in, never by reset.
        await dbi.updatePasswordHash('password', email, await hashPassword(body.password));
      }
      await bootstrapAdmin(env, dbi, identity.userId, email);
      return startSession(dbi, identity.userId, { ok: true, user: { id: identity.userId } }, origin);
    },

    async signout(request, env, origin) {
      const foreign = foreignOrigin(request, origin);
      if (foreign) return foreign;
      const token = readSessionCookie(request.headers.get('Cookie'));
      if (token) await db(env).deleteAuthSession(await sessionTokenHash(token));
      // Idempotent: signing out signed-out is success, and the cookie is
      // cleared either way.
      return json({ ok: true }, { origin, headers: { 'Set-Cookie': clearSessionCookie() } });
    },

    async me(request, env, origin) {
      const session = await resolveSession(request, env);
      if (!session) return json({ ok: false, error: 'unauthenticated' }, { status: 401, origin });
      const profile = await session.db.getProfile(session.userId);
      return json(
        {
          ok: true,
          user: {
            id: session.userId,
            displayName: session.displayName,
            role: session.role,
            verified: session.verified,
          },
          profile: profile
            ? {
                voiceId: profile.voice_id,
                voiceName: profile.voice_name,
                stylePrompt: profile.style_prompt,
                videoPathMs: profile.video_path_ms,
                hasAvatar: Boolean(profile.avatar_key),
              }
            : null,
        },
        { origin },
      );
    },

    async putProfile(request, env, origin) {
      const foreign = foreignOrigin(request, origin);
      if (foreign) return foreign;
      const session = await resolveSession(request, env);
      if (!session) return json({ ok: false, error: 'unauthenticated' }, { status: 401, origin });
      const body = await readJson(request);
      const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
      const videoPathMs =
        Number.isInteger(body?.videoPathMs) && body.videoPathMs >= 0 && body.videoPathMs <= 2000
          ? body.videoPathMs
          : undefined;
      // avatar_key is NOT client-writable — it is set by the upload path
      // (P4c) after the bytes actually land in R2. A client that could name
      // its own key could name someone else's.
      await session.db.upsertProfile(session.userId, {
        voiceId: str(body?.voiceId, 100),
        voiceName: str(body?.voiceName, 100),
        stylePrompt: str(body?.stylePrompt, 500),
        videoPathMs,
      });
      return json({ ok: true }, { origin });
    },
  };
}
