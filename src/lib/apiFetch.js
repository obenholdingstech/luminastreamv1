// The HTTP plumbing every API Worker client shares: a deadline, a JSON POST,
// and a human-readable error when the deadline fires.
//
// Extracted from serverMint.js when sessionClient.js needed the same thing. It
// is deliberately one implementation rather than two similar ones: `deadline()`
// is what stands between the app and a request that never settles, and the
// project has a documented reason to care — the CEO's Starlink link
// intermittently blackholes DNS, so "hangs forever" is an observed failure
// here, not a hypothetical.

export const DEFAULT_TIMEOUT_MS = 15_000;

/** True for the DOMException fetch raises when a signal fires. */
export function isAbort(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * A signal that fires after `ms`.
 *
 * AbortSignal.timeout is the direct route, but falling back to `null` when it
 * is missing would hand exactly the older runtimes that most need a deadline
 * the one code path that has none. AbortController plus a timer is universally
 * available and gives the same guarantee, so the fallback is a real deadline
 * rather than an absent one. Returns null only if even that fails, because a
 * missing convenience must never become a thrown request.
 */
export function deadline(ms = DEFAULT_TIMEOUT_MS) {
  try {
    if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    }, ms);
    // Never hold a Node process (or a test runner) open on a deadline that is
    // only there in case something else stalls. In the browser setTimeout
    // returns a number with no unref, which is why the call is guarded rather
    // than typed — the DOM lib types this as `number`.
    /** @type {any} */ (timer)?.unref?.();
    return controller.signal;
  } catch {
    return null;
  }
}

/**
 * POST JSON and read JSON back, never throwing on a non-2xx or a non-JSON body.
 *
 * @param {string} url
 * @param {{
 *   body?: unknown,
 *   adminToken?: string,
 *   signal?: AbortSignal|null,
 *   keepalive?: boolean,
 * }} [opts]
 */
export async function postJson(url, { body, adminToken, signal, keepalive } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    ...(signal ? { signal } : {}),
    // keepalive lets a request outlive the page that started it — the only way
    // to release a session slot on unload while still sending a header, which
    // sendBeacon cannot do.
    ...(keepalive ? { keepalive: true } : {}),
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
export function asTimeoutError(err) {
  if (!isAbort(err)) return err;
  return new Error('the server did not respond — check your connection and retry');
}
