// Client for the API Worker's admin gate + LiveKit token mint (workers/api).
// Only used by /livekit-test when VITE_API_BASE is set. Manual token paste
// stays the dev fallback, so none of this is on the critical drill path.

import { API_BASE } from './apiBase.js';

/**
 * @param {string} url
 * @param {{ body?: unknown, adminToken?: string }} [opts]
 */
async function postJson(url, { body, adminToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body (e.g. an SPA-shell 200 when the API base is misconfigured)
  }
  return { status: res.status, data };
}

// Exchange the admin password for a ~12h session token (sent back as
// X-Admin-Token). Throws a human-readable Error on failure.
export async function verifyAdmin(password, base = API_BASE) {
  if (!base) throw new Error('server API not configured (VITE_API_BASE unset)');
  const { status, data } = await postJson(`${base}/api/admin/verify`, { body: { password } });
  if (status === 200 && data?.token) return data.token;
  if (status === 401) throw new Error('wrong admin password');
  if (status === 429) throw new Error('too many attempts — wait a minute and retry');
  throw new Error(data?.error || `verify failed (HTTP ${status})`);
}

// Mint a LiveKit token with a valid admin session. On a 401 the returned Error
// carries `.status = 401` so the caller can re-verify and retry once.
export async function mintToken(adminToken, { room, identity }, base = API_BASE) {
  if (!base) throw new Error('server API not configured (VITE_API_BASE unset)');
  const { status, data } = await postJson(`${base}/api/livekit/token`, {
    adminToken,
    body: { room, identity },
  });
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
export async function mintViaServer({ password, adminToken, room, identity }, base = API_BASE) {
  let session = adminToken;
  if (!session) session = await verifyAdmin(password, base);
  try {
    const { token, url } = await mintToken(session, { room, identity }, base);
    return { token, url, adminToken: session };
  } catch (err) {
    if (err.status === 401 && password) {
      session = await verifyAdmin(password, base);
      const { token, url } = await mintToken(session, { room, identity }, base);
      return { token, url, adminToken: session };
    }
    throw err;
  }
}
