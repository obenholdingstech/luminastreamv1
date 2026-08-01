// Client for the API Worker's admin gate + LiveKit token mint (workers/api).
// Used by the lens at `/` to unlock a session, and by /livekit-test, where
// manual token paste stays the dev fallback so a drill never depends on the
// Worker being up.

import { API_BASE } from './apiBase.js';

// fetch() has NO timeout of its own. A request that hangs — a blackholed DNS
// lookup, a TCP connection that opens and then goes quiet — never settles, so
// a caller awaiting it waits forever with its button disabled and no error to
// show. On this project that is not a hypothetical: the CEO's Starlink link
// intermittently blackholes DNS, which is documented as a drill hazard.
//
// Every request therefore carries a deadline, and mintViaServer applies ONE
// deadline across its whole exchange rather than per hop, so a flow that needs
// four round trips still fails inside a span a person will actually wait out.
export const DEFAULT_TIMEOUT_MS = 15_000;

/** True for the DOMException fetch raises when a signal fires. */
function isAbort(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * A signal that fires after `ms`, or null where the runtime lacks
 * AbortSignal.timeout. Absent support means no deadline — never a thrown
 * request, which would turn a missing convenience into a broken unlock.
 */
function deadline(ms = DEFAULT_TIMEOUT_MS) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {{ body?: unknown, adminToken?: string, signal?: AbortSignal|null }} [opts]
 */
async function postJson(url, { body, adminToken, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    ...(signal ? { signal } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body (e.g. an SPA-shell 200 when the API base is misconfigured)
  }
  return { status: res.status, data };
}

/** Turn an aborted request into something worth showing a person. */
function asTimeoutError(err) {
  if (!isAbort(err)) return err;
  return new Error('the server did not respond — check your connection and retry');
}

// Exchange the admin password for a ~12h session token (sent back as
// X-Admin-Token). Throws a human-readable Error on failure.
export async function verifyAdmin(password, base = API_BASE, signal = deadline()) {
  if (!base) throw new Error('server API not configured (VITE_API_BASE unset)');
  let status;
  let data;
  try {
    ({ status, data } = await postJson(`${base}/api/admin/verify`, {
      body: { password },
      signal,
    }));
  } catch (err) {
    throw asTimeoutError(err);
  }
  if (status === 200 && data?.token) return data.token;
  if (status === 401) throw new Error('wrong admin password');
  if (status === 429) throw new Error('too many attempts — wait a minute and retry');
  throw new Error(data?.error || `verify failed (HTTP ${status})`);
}

// Mint a LiveKit token with a valid admin session. On a 401 the returned Error
// carries `.status = 401` so the caller can re-verify and retry once.
export async function mintToken(
  adminToken,
  { room, identity },
  base = API_BASE,
  signal = deadline(),
) {
  if (!base) throw new Error('server API not configured (VITE_API_BASE unset)');
  let status;
  let data;
  try {
    ({ status, data } = await postJson(`${base}/api/livekit/token`, {
      adminToken,
      body: { room, identity },
      signal,
    }));
  } catch (err) {
    throw asTimeoutError(err);
  }
  if (status === 200 && data?.token) return { token: data.token, url: data.url ?? '' };
  const err = /** @type {Error & { status?: number }} */ (
    new Error(
      status === 401
        ? 'admin session expired'
        : status === 429
          ? 'mint rate-limited — wait a minute and retry'
          : data?.error || `mint failed (HTTP ${status})`,
    )
  );
  err.status = status;
  throw err;
}

// Full flow: reuse an existing session if we have one, transparently
// re-authenticating with the password once if it has expired. Returns
// { token, url, adminToken } — adminToken is the (possibly refreshed) session.
//
// The deadline is created ONCE and shared by every hop. A per-hop timeout would
// let the worst case stack to four times the budget, which is long enough that
// a person concludes the app is broken rather than slow.
export async function mintViaServer(
  { password, adminToken, room, identity, timeoutMs = DEFAULT_TIMEOUT_MS },
  base = API_BASE,
) {
  const signal = deadline(timeoutMs);
  let session = adminToken;
  if (!session) session = await verifyAdmin(password, base, signal);
  try {
    const { token, url } = await mintToken(session, { room, identity }, base, signal);
    return { token, url, adminToken: session };
  } catch (err) {
    if (err.status === 401 && password) {
      session = await verifyAdmin(password, base, signal);
      const { token, url } = await mintToken(session, { room, identity }, base, signal);
      return { token, url, adminToken: session };
    }
    throw err;
  }
}
