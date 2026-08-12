// The tuning-request lifecycle, pure (CodeRabbit, PR 115). A committed
// slider value is a REQUEST: the publish only promises delivery, and the
// agent answers later through its agent_config broadcast (applied truth,
// an `adjusted` clamp, or a `rejected` refusal). Until one of those
// answers, the UI must keep showing what was asked — snapping back to
// the old confirmed value would misreport the user's own action. A
// failed publish clears immediately (with a visible error, component-
// side): nothing was asked, so nothing is pending.

/** A new request begins (after a SUCCESSFUL publish). */
export function beginRequest(pending, name, value) {
  return { ...pending, [name]: value };
}

/** A request ends without an answer (failed publish, disconnect). */
export function clearRequest(pending, name) {
  const next = { ...pending };
  delete next[name];
  return next;
}

/**
 * Resolve pendings against a fresh broadcast. A pending clears when the
 * broadcast ANSWERS it: the applied value equals the request, or the
 * agent reported it adjusted (clamped elsewhere) or rejected. A
 * broadcast that says nothing about the knob leaves it pending — an
 * unrelated re-broadcast must not swallow an in-flight request.
 */
export function resolveRequests(pending, broadcast, epsilon = 1e-6) {
  const { config, adjusted, rejected } = broadcast ?? {};
  const out = {};
  for (const [name, value] of Object.entries(pending)) {
    const answered =
      (rejected && name in rejected) ||
      (adjusted && name in adjusted) ||
      (typeof config?.[name] === 'number' && Math.abs(config[name] - value) <= epsilon);
    if (!answered) out[name] = value;
  }
  return out;
}
