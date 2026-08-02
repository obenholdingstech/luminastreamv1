// Client for the API Worker's admin gate + LiveKit token mint (workers/api).
// Used by the lens at `/` to unlock a session, and by /livekit-test, where
// manual token paste stays the dev fallback so a drill never depends on the
// Worker being up.
//
// The deadline, the JSON POST and the timeout message live in apiFetch.js —
// one implementation, shared with sessionClient.js. mintViaServer applies ONE
// deadline across its whole exchange rather than per hop, so a flow that needs
// four round trips still fails inside a span a person will actually wait out.

import { API_BASE } from './apiBase.js';
import { DEFAULT_TIMEOUT_MS, deadline, postJson, asTimeoutError } from './apiFetch.js';

export { DEFAULT_TIMEOUT_MS };

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
