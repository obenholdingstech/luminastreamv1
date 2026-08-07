// The ONE way a request becomes a signed-in user (P4b/realignment). Both the
// auth routes and the session gate resolve through here, so "who is this"
// has a single answer with a single touch-throttle policy — two resolvers
// would eventually disagree about expiry or suspension, and an auth
// disagreement is a security bug wearing a race's clothes.

import { LAST_SEEN_THROTTLE_SECONDS, readSessionCookie, sessionTokenHash } from './auth.js';
import { isTrustedForCredentials } from './cors.js';

/**
 * Resolve the request's cookie to a live user session, or null.
 * Touches last_seen at most once an hour — activity is coarse by design.
 *
 * @returns {Promise<null | {
 *   userId: string, displayName: string|null, role: string,
 *   verified: boolean, tokenHash: string, db: any,
 * }>}
 */
export async function resolveUserSession(request, env, createDb) {
  // CSRF wall (CodeRabbit, PR 88): a PRESENT Origin outside the trusted
  // tier means a cross-site browser auto-attached this cookie — the request
  // resolves as ANONYMOUS (falls through to the ops-token check, which the
  // attacker cannot satisfy). Absent Origin (curl, native) is fine: those
  // clients never carry a victim's cookie. Same rule the auth routes apply.
  const originHeader = request.headers.get('Origin');
  if (originHeader && !isTrustedForCredentials(originHeader)) return null;
  const token = readSessionCookie(request.headers.get('Cookie'));
  if (!token || !env.IDENTITY_DB) return null;
  const db = createDb(env.IDENTITY_DB);
  const tokenHash = await sessionTokenHash(token);
  const session = await db.findAuthSession(tokenHash);
  if (!session) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - session.lastSeenAt >= LAST_SEEN_THROTTLE_SECONDS) {
    await db.touchAuthSession(tokenHash);
  }
  return { ...session, tokenHash, db };
}

/**
 * May this user open a lens session? Admins always; everyone else once an
 * identity of theirs is verified. During the dev window (no mail provider
 * yet) this means exactly the ADMIN_EMAILS accounts pass — the same wall
 * the retired admin password provided, now attached to real identity.
 */
export function mayStartSession(session) {
  return Boolean(session && (session.role === 'admin' || session.verified));
}
