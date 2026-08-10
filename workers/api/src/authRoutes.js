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
import { emailEnabled, sendVerificationEmail } from './email.js';
import { anyVendorKey } from './vendorKeys.js';

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

  const ACCOUNT_URL = 'https://account.luminastream.live';
  const STUDIO_URL = 'https://studio.luminastream.live';

  // Turnstile (bot wall at sign-up). ENV-GATED: enforced only when the
  // secret exists — a deploy without the key degrades to the rate limiter
  // alone rather than refusing every human. Verified server-side with
  // Cloudflare's siteverify; the client token is single-use.
  const turnstileRefusal = async (env, request, body, origin) => {
    if (!env.TURNSTILE_SECRET_KEY) return null;
    const token = typeof body?.turnstileToken === 'string' ? body.turnstileToken : '';
    if (!token) return json({ ok: false, error: 'turnstile_required' }, { status: 403, origin });
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: clientIp(request),
        }),
      });
      const verdict = await res.json().catch(() => null);
      if (verdict?.success === true) return null;
    } catch (err) {
      console.error('turnstile siteverify failed', err);
    }
    // Fail CLOSED: an unverifiable challenge refuses — a broken bot wall
    // must never resolve to an open door (doctrine 26).
    return json({ ok: false, error: 'turnstile_failed' }, { status: 403, origin });
  };

  /** Mint + store + send one verification token. Failures reported, never thrown. */
  const startVerification = async (env, dbi, userId, email) => {
    if (!emailEnabled(env)) return { ok: false, error: 'email_disabled' };
    const token = newSessionToken(); // same entropy class as sessions
    await dbi.createEmailVerification({
      tokenHash: await sessionTokenHash(token),
      userId,
      subject: email,
      ttlSeconds: 24 * 3600,
    });
    return sendVerificationEmail(env, {
      to: email,
      link: `https://api.luminastream.live/api/auth/verify?token=${token}`,
    });
  };

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

  // TWO-WAY sync with the allowlist (CodeRabbit, PR 87 — revocation must be
  // definable): a listed email is promoted; an admin whose email left the
  // list is DEMOTED at their next sign-in. Writes happen only on CHANGE (no
  // per-sign-in write for the common case). This auto-demote exists only
  // while the allowlist is the sole source of admin — P8's role management
  // replaces it and must remove the demote path, or it would fight P8's own
  // grants. Immediate revocation (before a sign-in) is user suspension.
  const syncAdminRole = async (env, dbi, userId, email, currentRole) => {
    const listed = adminEmails(env).includes(email);
    if (listed && currentRole !== 'admin') await dbi.setRole(userId, 'admin');
    if (!listed && currentRole === 'admin') await dbi.setRole(userId, 'user');
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
      const bot = await turnstileRefusal(env, request, body, origin);
      if (bot) return bot;
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
      await syncAdminRole(env, dbi, userId, email, 'user');
      const verification = await startVerification(env, dbi, userId, email);
      return startSession(
        dbi,
        userId,
        { ok: true, user: { id: userId, displayName }, verificationSent: verification.ok },
        origin,
      );
    },

    /** Re-send the verification mail for the signed-in account. */
    async resendVerification(request, env, origin) {
      const foreign = foreignOrigin(request, origin);
      if (foreign) return foreign;
      const refusal = await limited(env, origin, `verify-send:${clientIp(request)}`);
      if (refusal) return refusal;
      const session = await resolveSession(request, env);
      if (!session) return json({ ok: false, error: 'unauthenticated' }, { status: 401, origin });
      if (session.verified) return json({ ok: true, alreadyVerified: true }, { origin });
      // The subject is the account's password identity email.
      const row = await session.db.findIdentitySubject?.(session.userId);
      const email = row?.subject;
      if (!email) return json({ ok: false, error: 'no_email_identity' }, { status: 409, origin });
      const sent = await startVerification(env, session.db, session.userId, email);
      return json(sent.ok ? { ok: true } : { ok: false, error: sent.error }, {
        status: sent.ok ? 200 : 503,
        origin,
      });
    },

    /** The click in the mail. GET by nature (a mail client's link); the
     * token is one-shot and hashed at rest, so GET is safe here. Lands on
     * the account surface with the outcome in the URL. */
    async verifyEmail(request, env, origin) {
      const url = new URL(request.url);
      const token = url.searchParams.get('token') ?? '';
      const redirect = (outcome) =>
        new Response(null, {
          status: 302,
          headers: { Location: `${ACCOUNT_URL}/?verify=${outcome}` },
        });
      if (!token) return redirect('invalid');
      const dbi = db(env);
      const consumed = await dbi.consumeEmailVerification(await sessionTokenHash(token));
      if (!consumed) return redirect('expired');
      await dbi.markIdentityVerified(consumed.userId, consumed.subject);
      return redirect('ok');
    },

    /** Public client config — only values that are public BY DESIGN. */
    async config(request, env, origin) {
      return json(
        {
          ok: true,
          googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
          emailEnabled: emailEnabled(env),
          turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
          // Presence only, never a key: a non-empty POOL behind the one
          // ELEVENLABS_API_KEY interface (10 Aug 2026). A pool claim, not a
          // health claim — the 9 Aug incident taught the difference.
          voiceCloningEnabled: anyVendorKey(env),
        },
        { origin },
      );
    },

    /** Google sign-in, leg 1: redirect out with a state cookie (CSRF). */
    async googleStart(request, env, origin) {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return json({ ok: false, error: 'google_disabled' }, { status: 404, origin });
      }
      const state = newSessionToken();
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: 'https://api.luminastream.live/api/auth/google/callback',
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
          // Lax survives the top-level redirect back; 10 minutes is the
          // whole ceremony's lifetime.
          'Set-Cookie': `__Secure-lumina-oauth=${state}; Max-Age=600; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    },

    /** Google sign-in, leg 2: code → tokens → identity → session → studio.
     * The id_token arrives DIRECTLY from Google's token endpoint over TLS in
     * a confidential-client exchange, which is what makes payload checks
     * (iss/aud/exp/email_verified) sufficient without JWKS signature
     * verification — nothing untrusted ever carried the token. */
    async googleCallback(request, env, origin) {
      const fail = (reason) =>
        new Response(null, {
          status: 302,
          headers: { Location: `${ACCOUNT_URL}/?oauth=${reason}` },
        });
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail('disabled');
      const url = new URL(request.url);
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const cookieState = (request.headers.get('Cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Secure-lumina-oauth='))
        ?.slice('__Secure-lumina-oauth='.length);
      if (!code || !state || state !== cookieState) return fail('state');

      let payload;
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: 'https://api.luminastream.live/api/auth/google/callback',
            grant_type: 'authorization_code',
          }),
        });
        const tokens = await tokenRes.json().catch(() => null);
        const idToken = tokens?.id_token;
        if (!tokenRes.ok || typeof idToken !== 'string') return fail('exchange');
        const [, body64] = idToken.split('.');
        payload = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(
              atob(body64.replace(/-/g, '+').replace(/_/g, '/')),
              (c) => c.charCodeAt(0),
            ),
          ),
        );
      } catch (err) {
        console.error('google exchange failed', err);
        return fail('exchange');
      }
      const issOk = payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com';
      if (!issOk || payload?.aud !== env.GOOGLE_CLIENT_ID) return fail('claims');
      if (!(Number(payload?.exp) > Math.floor(Date.now() / 1000))) return fail('claims');
      if (payload?.email_verified !== true || typeof payload?.sub !== 'string') return fail('claims');

      const email = normalizeEmail(payload.email);
      const dbi = db(env);
      // Google's stable subject is the identity key — never the email
      // (providers let emails change and hide). No auto-link to password
      // accounts in v1: linking is an explicit P8 operation, because silent
      // merges are how account takeovers hide inside conveniences.
      let identity = await dbi.findIdentity('google', payload.sub);
      let userId;
      let role = 'user';
      if (identity) {
        ({ userId, role } = identity);
      } else {
        ({ userId } = await dbi.createUserWithIdentity({
          provider: 'google',
          subject: payload.sub,
          passwordHash: null,
          displayName: typeof payload.name === 'string' ? payload.name.slice(0, 80) : null,
          verified: true, // Google asserted the email
        }));
      }
      await syncAdminRole(env, dbi, userId, email, role);
      const sessionToken = newSessionToken();
      await dbi.createAuthSession({
        tokenHash: await sessionTokenHash(sessionToken),
        userId,
        ttlSeconds: SESSION_TTL_SECONDS,
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${STUDIO_URL}/`,
          'Set-Cookie': sessionCookie(sessionToken),
        },
      });
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
      await syncAdminRole(env, dbi, identity.userId, email, identity.role);
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
