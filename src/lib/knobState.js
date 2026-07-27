// Applied-truth derivation for the Phase 4 tuning console.
//
// The UI's confirmed badge renders ONLY the agent-broadcast applied value;
// this helper only decides how to color it relative to what the user asked
// for. Kept as a pure module so it is unit-testable with `node --test`
// (the repo has no browser test runner).

/**
 * @param {number|string|undefined} requested the value the UI last asked for
 * @param {number|string|undefined} applied   the agent-confirmed value
 * @returns {'unknown'|'match'|'mismatch'}
 */
export function knobState(requested, applied, epsilon = 1e-6) {
  if (applied === undefined || applied === null) return 'unknown';
  if (requested === undefined || requested === null) return 'match'; // nothing asked → truth stands
  if (typeof applied === 'number' && typeof requested === 'number') {
    return Math.abs(applied - requested) <= epsilon ? 'match' : 'mismatch';
  }
  return applied === requested ? 'match' : 'mismatch';
}

/** Display text for a confirmed badge — always the APPLIED value, never the request. */
export function knobDisplay(applied) {
  if (applied === undefined || applied === null) return '—';
  if (typeof applied === 'number') {
    return Number.isInteger(applied) ? String(applied) : applied.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(applied);
}

export const KNOB_STATE_COLORS = {
  match: '#10B981',
  mismatch: '#F59E0B',
  unknown: '#64748B',
};
