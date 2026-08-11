// The voice library's decisions, as pure functions (CodeRabbit, PR 95 —
// the adminGate/voiceSelection rule again: logic with real behavior lives
// in src/lib/ with a test beside it; the component keeps only React state
// and the FileReader).
//
// The component maps each result to exactly two effects: `notice` goes to
// the status line verbatim, `changed` decides whether to reload the list
// and fire refresh_voices at the agent.

// The PICK gate (11 Aug 2026): big audio and video containers are welcome —
// the browser extracts a compact mono WAV before anything crosses the wire,
// so the server's sample wall is a property of the EXTRACTION, not the pick.
export const SAMPLE_LIMIT_BYTES = 150 * 1024 * 1024;

/** Why this file cannot be a sample — or null when it can. */
export function sampleRefusal(file) {
  if (!file) return 'no file chosen';
  if (file.size > SAMPLE_LIMIT_BYTES) {
    return 'that file is over 150MB — trim it down first';
  }
  return null;
}

/** A clone label from a filename: extension off, trimmed, never empty. */
export function cloneLabel(filename) {
  const stem = String(filename ?? '')
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, 60);
  return stem || 'My voice';
}

const FALLBACK = 'that did not work — try again';

/** Clone outcome → panel effects. Only success touches the library. */
export function afterClone(res) {
  if (res?.ok) {
    return { notice: 'voice cloned — it appears in the selector shortly', changed: true };
  }
  return { notice: res?.message ?? FALLBACK, changed: false };
}

/**
 * Delete outcome → panel effects. `changed` is true EITHER way: a failed
 * delete may still have drifted server-side state (the vendor half can
 * succeed before the row refuses), so the list reloads to whatever is true.
 */
export function afterDelete(res) {
  return { notice: res?.ok ? '' : (res?.message ?? FALLBACK), changed: true };
}
