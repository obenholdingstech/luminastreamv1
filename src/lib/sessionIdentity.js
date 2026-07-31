// Per-tab LiveKit identity.
//
// LiveKit evicts an existing participant when a second connection arrives
// using the same identity. The mint panel used to default to the literal
// string 'test-user', so every person — and every second tab — arrived as
// the same participant and kicked whoever was already there. The symptom
// reads like a capacity limit or a flaky connection; it is neither. It is a
// name collision.
//
// Scope is deliberately sessionStorage, not localStorage:
//   - same tab, reload  → same identity. A reconnect reclaims your own slot
//     instead of stacking a second ghost participant in the room.
//   - second tab / another person → different identity. No eviction.
//
// This does NOT make the room multi-user. The agent adopts exactly one
// speaker (convert_agent.py `_maybe_adopt`); a second participant is
// ignored and hears nothing back. That limit is real and is surfaced in the
// UI via the agent's `agent_busy` broadcast. Room-per-session is the actual
// fix and lands with /api/session/create.

const STORAGE_KEY = 'luminastream_identity';

// Base36 keeps it short and URL-safe. 8 chars of crypto randomness is ~41
// bits — far past what a handful of concurrent tabs needs, and it never
// touches Math.random, which is not required to be unpredictable.
function randomSuffix(length = 8) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

/**
 * A stable-per-tab identity, e.g. `studio-k3f9a1zq`.
 *
 * Falls back to a fresh non-persisted value if sessionStorage is unavailable
 * (Safari private mode, embedded webviews, storage disabled). A fresh value
 * is always safe here — worst case a reload looks like a new participant,
 * which is still strictly better than colliding with someone else.
 *
 * @param {string} prefix Human-readable role, e.g. 'studio' or 'devtools'.
 * @returns {string}
 */
export function getSessionIdentity(prefix = 'studio') {
  const key = `${STORAGE_KEY}_${prefix}`;
  try {
    const existing = globalThis.sessionStorage?.getItem(key);
    if (existing) return existing;
    const fresh = `${prefix}-${randomSuffix()}`;
    globalThis.sessionStorage?.setItem(key, fresh);
    return fresh;
  } catch {
    return `${prefix}-${randomSuffix()}`;
  }
}

/**
 * Discard this tab's identity so the next call mints a new one. Used when
 * the user deliberately wants a clean participant (e.g. after being evicted
 * by their own stale connection).
 *
 * @param {string} prefix
 */
export function resetSessionIdentity(prefix = 'studio') {
  try {
    globalThis.sessionStorage?.removeItem(`${STORAGE_KEY}_${prefix}`);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
