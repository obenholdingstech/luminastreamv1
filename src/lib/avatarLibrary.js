// The avatar library's decisions, as pure functions — the voiceLibrary
// pattern, applied at birth instead of at review (#95's finding, learned
// once). The component maps each outcome to exactly two effects: `notice`
// to the status line verbatim, `changed` to a list reload.

const FALLBACK = 'that did not work — try again';

/** Upload outcome → panel effects. Success reloads AND reports the new id
 * so the caller can treat it as the live selection. */
export function afterUpload(res) {
  if (res?.ok && res.id) {
    return { notice: 'avatar saved — it is now your selected identity', changed: true, id: res.id };
  }
  return { notice: res?.message ?? FALLBACK, changed: false, id: null };
}

/** Select outcome → panel effects. A refusal changes nothing visible. */
export function afterSelect(res) {
  if (res?.ok) return { notice: '', changed: true };
  return { notice: res?.message ?? FALLBACK, changed: false };
}

/**
 * Delete outcome → panel effects. `changed` either way — a failed delete
 * may still have drifted server state, so the list reloads to what is true.
 */
export function afterDelete(res) {
  return { notice: res?.ok ? '' : (res?.message ?? FALLBACK), changed: true };
}
