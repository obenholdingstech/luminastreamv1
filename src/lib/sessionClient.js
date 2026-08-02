// Client for the API Worker's session layer (workers/api, /api/session/*).
//
// This replaces the lens's old flow, which hardcoded a room name and asked for
// a LiveKit token to join it. That worked because exactly one room existed. The
// server now decides: it allocates a room an agent is actually serving, an
// identity that cannot collide, and a grant scoped to both — and it refuses
// when there is nothing free rather than letting a second person into a room
// where the agent is already busy with someone else.
//
// The lifecycle matters as much as the call. A session HOLDS a slot from create
// until end, so the lens takes one when streaming starts and gives it back when
// streaming stops — not at unlock, and not "eventually". A slot nobody released
// stays held until its lease expires (two hours), which on a one-agent system
// means one abandoned tab locks everyone else out for the afternoon.

import { API_BASE } from './apiBase.js';
import { DEFAULT_TIMEOUT_MS, deadline, postJson, asTimeoutError } from './apiFetch.js';
import { verifyAdmin } from './serverMint.js';

export { DEFAULT_TIMEOUT_MS };

/**
 * Errors carry `.status` and `.code` so callers can branch on the reason
 * without matching on prose. `at_capacity` and `sessions_disabled` are both
 * 503 and mean opposite things about whether retrying is worth it.
 *
 * `at_capacity` additionally carries live/capacity/pool, because "the lens is
 * busy" reads identically whether someone else is talking or a stuck slot is
 * holding the only room — and those two want opposite actions.
 *
 * @param {string} message
 * @param {{ status?: number, code?: string }} [meta]
 * @returns {Error & { status?: number, code?: string, live?: number, capacity?: number, pool?: number }}
 */
function sessionError(message, { status, code } = {}) {
  const err = /** @type {Error & { status?: number, code?: string, live?: number, capacity?: number, pool?: number }} */ (
    new Error(message)
  );
  if (status !== undefined) err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

function describeRefusal(status, data) {
  const code = data?.error;
  if (code === 'at_capacity') {
    // Deliberately about people, not slots: "capacity" is our word for it and
    // means nothing to whoever is trying to talk.
    //
    // The counts ride along on the error because the first live drill produced
    // this message with no way to tell "someone else is talking" apart from "a
    // stuck slot is holding the only room". Same sentence, opposite actions.
    const err = sessionError('the lens is busy right now — try again in a moment', {
      status,
      code,
    });
    err.live = data?.live;
    err.capacity = data?.capacity;
    err.pool = data?.pool;
    return err;
  }
  if (code === 'sessions_disabled') {
    // Permanent for this deployment. Saying "try again" here would be a lie
    // that costs someone an afternoon of retrying.
    return sessionError('this deployment is not serving sessions', { status, code });
  }
  if (status === 401) return sessionError('admin session expired', { status, code });
  if (status === 429) {
    return sessionError('too many attempts — wait a minute and retry', { status, code });
  }
  if (code === 'session_registry_unavailable') {
    return sessionError('the session service is unavailable — try again shortly', {
      status,
      code,
    });
  }
  // Prose, never the raw code. An unnamed or future code used as the message
  // puts a machine token in front of a person — the same defect the named
  // branches above exist to avoid, reached through the door nobody looked at.
  // The code still travels on `.code` for callers that want to branch.
  return sessionError(`could not start a session (HTTP ${status})`, { status, code });
}

/**
 * Claim a slot. Returns the room, identity and LiveKit grant the server chose,
 * plus the `endToken` that releases it again.
 *
 * @param {string} adminToken
 * @param {string} [base]
 * @param {AbortSignal|null} [signal]
 */
export async function createSession(adminToken, base = API_BASE, signal = deadline()) {
  if (!base) throw sessionError('server API not configured (VITE_API_BASE unset)');
  let status;
  let data;
  try {
    ({ status, data } = await postJson(`${base}/api/session/create`, { adminToken, signal }));
  } catch (err) {
    throw asTimeoutError(err);
  }
  if (status === 200 && data?.ok && data.token) {
    return {
      sessionId: data.sessionId,
      endToken: data.endToken,
      room: data.room,
      identity: data.identity,
      token: data.token,
      url: data.url ?? '',
      expiresAt: data.expiresAt,
    };
  }
  throw describeRefusal(status, data);
}

/**
 * Give the slot back.
 *
 * Never throws. Releasing is best-effort by nature — it runs on a Stop click
 * and again as the page unloads, and a failure there has a floor: the lease
 * reaps the slot anyway. Turning that into an exception would only produce an
 * error message about something the user already finished doing.
 *
 * @param {string} adminToken
 * @param {{ sessionId: string, endToken: string }} session
 * @param {string} [base]
 * @param {{ keepalive?: boolean, signal?: AbortSignal|null }} [opts]
 */
export async function endSession(
  adminToken,
  { sessionId, endToken } = /** @type {any} */ ({}),
  base = API_BASE,
  { keepalive = false, signal } = {},
) {
  if (!base || !sessionId || !endToken) return false;
  try {
    const { status, data } = await postJson(`${base}/api/session/end`, {
      adminToken,
      body: { sessionId, endToken },
      signal: signal === undefined ? deadline() : signal,
      keepalive,
    });
    return status === 200 && Boolean(data?.ok);
  } catch {
    return false;
  }
}

/**
 * Release a slot from a page that is going away.
 *
 * `fetch(..., { keepalive: true })` rather than `navigator.sendBeacon`: the
 * endpoint is gated on the `X-Admin-Token` header, and sendBeacon cannot set
 * headers. keepalive lets the request outlive the document, which is the whole
 * requirement. No deadline — an AbortSignal on an unload request is a race we
 * would rather not run, and the lease is the backstop if it never lands.
 *
 * @param {string} adminToken
 * @param {{ sessionId: string, endToken: string }} session
 * @param {string} [base]
 */
export function releaseOnUnload(adminToken, session, base = API_BASE) {
  return endSession(adminToken, session, base, { keepalive: true, signal: null });
}

/**
 * Full flow: reuse the admin session if we have one, re-authenticating with the
 * password once if it has expired, then claim a slot.
 *
 * One deadline is created here and shared by every hop, exactly as
 * mintViaServer does. Per-hop timeouts would let the worst case stack to
 * several times the budget — long enough that a person concludes the app is
 * broken rather than slow.
 *
 * @param {{ password?: string, adminToken?: string, timeoutMs?: number }} args
 * @param {string} [base]
 */
export async function openSession(
  { password, adminToken, timeoutMs = DEFAULT_TIMEOUT_MS },
  base = API_BASE,
) {
  const signal = deadline(timeoutMs);
  let session = adminToken;
  if (!session) session = await verifyAdmin(password, base, signal);

  try {
    return { ...(await createSession(session, base, signal)), adminToken: session };
  } catch (err) {
    // Only a 401 is worth retrying, and only with a password to retry WITH.
    // Retrying at_capacity here would hammer a full registry on the user's
    // behalf and still fail.
    if (err.status === 401 && password) {
      session = await verifyAdmin(password, base, signal);
      try {
        return { ...(await createSession(session, base, signal)), adminToken: session };
      } catch (retryErr) {
        throw withAdminToken(retryErr, session);
      }
    }
    // The password was already exchanged successfully — a busy lens must not
    // also cost the user their credentials. Handing the verified session back
    // on the error means "try again" is one button, not a re-login.
    throw withAdminToken(err, session);
  }
}

/** Attach the (valid) admin session to a failure so the caller can keep it. */
function withAdminToken(err, adminToken) {
  if (err && adminToken && err.status !== 401) err.adminToken = adminToken;
  return err;
}
