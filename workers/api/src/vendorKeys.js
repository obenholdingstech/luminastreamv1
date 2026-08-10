// The vendor keyring (CEO architecture, 10 Aug 2026). ELEVENLABS_API_KEY
// keeps its name everywhere; its VALUE is the pool — an ordered,
// comma-separated key list. Order IS preference (first key = the cloning
// target), membership IS the operator's liveness assertion (removing a dead
// account's key is what triggers the voice healer). A bare single key is a
// pool of one — full back-compat.
//
// Accounts are labeled by KEY FINGERPRINT (`k` + first 8 hex of
// sha256(key)) — stable across list reordering, safe to log, stored per
// clone in user_voices.vendor_account. The raw key appears in no log line
// and no response, ever.

/** @returns {Promise<string>} `k` + first 8 hex of sha256(key). */
export async function fingerprintKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `k${hex.slice(0, 8)}`;
}

/**
 * The ordered pool from the env value. De-duplicated, whitespace-tolerant;
 * [] for absent/blank — callers keep their existing fail-closed shapes
 * (503 voice_vendor_unconfigured on an empty pool).
 * @returns {Promise<Array<{fingerprint: string, key: string}>>}
 */
export async function parsePool(envValue) {
  if (!envValue || typeof envValue !== 'string') return [];
  const seen = new Set();
  const pool = [];
  for (const part of envValue.split(',')) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push({ fingerprint: await fingerprintKey(key), key });
  }
  return pool;
}

/** Any key at all? (The presence flag — a pool claim, not a health claim.) */
export function anyVendorKey(env) {
  return Boolean(
    typeof env.ELEVENLABS_API_KEY === 'string' && env.ELEVENLABS_API_KEY.trim().replaceAll(',', ''),
  );
}

/**
 * Is this vendor refusal a MONEY refusal (worth trying the next key)?
 * Anything else — bad sample, rate limit, server error — is not: retrying
 * a deterministic rejection on another account would double-spend.
 */
export function isPaymentRefusal(status, detail) {
  if (status !== 401 && status !== 402) return false;
  const text = JSON.stringify(detail ?? '').toLowerCase();
  return ['payment_required', 'payment_issue', 'quota_exceeded', 'payment', 'billing'].some(
    (marker) => text.includes(marker),
  );
}
