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
const CLAIM_KEY = 'luminastream_identity_claims';
// A tab that holds an identity refreshes its claim on every read. Anything
// older than this is treated as a closed tab and its identity is free.
const CLAIM_TTL_MS = 30_000;

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

// Unique per document, generated in memory at module evaluation. This is the
// one value a duplicated tab CANNOT inherit: sessionStorage is copied into an
// auxiliary browsing context, but a fresh document re-evaluates the module and
// gets a new TAB_ID. That asymmetry is what makes copied identities detectable.
const TAB_ID = randomSuffix(12);

function readClaims() {
  try {
    const raw = globalThis.localStorage?.getItem(CLAIM_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaims(claims) {
  try {
    globalThis.localStorage?.setItem(CLAIM_KEY, JSON.stringify(claims));
  } catch {
    // No localStorage — we lose duplicate-tab detection but never correctness
    // of the sessionStorage path. Documented limitation, not a failure.
  }
}

/** True when another live document currently holds this identity. */
function heldByAnotherTab(identity, now) {
  const claim = readClaims()[identity];
  return Boolean(claim) && claim.tab !== TAB_ID && now - claim.t < CLAIM_TTL_MS;
}

/**
 * Hand back every claim this document holds.
 *
 * Load-bearing for reloads, not just tidiness. A reload keeps sessionStorage
 * but produces a NEW document, and therefore a new TAB_ID — so without this,
 * the identity we just refreshed looks like it belongs to a live stranger and
 * every reload would mint a new participant. The TTL alone does not save us,
 * because the claim was refreshed moments earlier.
 *
 * Exported for tests; wired to `pagehide` in browsers below.
 */
export function releaseSessionClaims() {
  const claims = readClaims();
  let touched = false;
  for (const [id, c] of Object.entries(claims)) {
    if (c && c.tab === TAB_ID) {
      delete claims[id];
      touched = true;
    }
  }
  if (touched) writeClaims(claims);
}

// `pagehide` is the reliable teardown signal — `unload` is unreliable and
// blocks the back/forward cache. Restoring from bfcache re-runs `pageshow`
// without re-evaluating the module, so we re-assert our claims there.
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', releaseSessionClaims);
  globalThis.addEventListener('pageshow', () => {
    // Optional chaining does not help here: in Safari private mode the
    // `sessionStorage` getter itself throws, so the access must be guarded.
    // Nothing to restore is a fine outcome — never a thrown handler.
    try {
      const now = Date.now();
      for (const prefix of ['studio', 'devtools']) {
        const held = globalThis.sessionStorage?.getItem(`${STORAGE_KEY}_${prefix}`);
        if (held) claim(held, now);
      }
    } catch {
      // Storage unavailable — skip claim restoration.
    }
  });
}

function claim(identity, now) {
  const claims = readClaims();
  // Opportunistically drop expired entries so the record can't grow forever.
  for (const [id, c] of Object.entries(claims)) {
    if (!c || now - c.t >= CLAIM_TTL_MS) delete claims[id];
  }
  claims[identity] = { tab: TAB_ID, t: now };
  writeClaims(claims);
}

/**
 * A stable-per-tab identity, e.g. `studio-k3f9a1zq`.
 *
 * Stable across reloads in the same tab, distinct in every other tab —
 * including a tab **duplicated** from this one. Duplication is the case worth
 * calling out: opening a link with cmd-click, `target="_blank"`, or "Duplicate
 * Tab" copies the opener's sessionStorage into the new document, so the naive
 * read would hand back the opener's identity and evict it. We detect that by
 * cross-checking a claim record in localStorage — which is shared between tabs
 * rather than copied — against this document's in-memory TAB_ID.
 *
 * Falls back to a fresh non-persisted value if sessionStorage is unavailable
 * (Safari private mode, embedded webviews). A fresh value is always safe here:
 * worst case a reload looks like a new participant, which is still strictly
 * better than colliding with someone else.
 *
 * Residual limitation, deliberately accepted: a tab that dies without clearing
 * its claim keeps it for CLAIM_TTL_MS, so a reload inside that window mints a
 * new identity instead of reclaiming the old one. Erring toward a spare
 * participant beats erring toward an eviction. Server-side allocation via
 * /api/session/create removes the guesswork entirely.
 *
 * @param {string} prefix Human-readable role, e.g. 'studio' or 'devtools'.
 * @returns {string}
 */
export function getSessionIdentity(prefix = 'studio') {
  const key = `${STORAGE_KEY}_${prefix}`;
  const now = Date.now();
  try {
    const existing = globalThis.sessionStorage?.getItem(key);
    if (existing && !heldByAnotherTab(existing, now)) {
      claim(existing, now); // refresh our lease
      return existing;
    }
    const fresh = `${prefix}-${randomSuffix()}`;
    globalThis.sessionStorage?.setItem(key, fresh);
    claim(fresh, now);
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
