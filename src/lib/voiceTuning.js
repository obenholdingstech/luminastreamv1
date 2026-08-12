// The Advanced Voice Settings decisions (CEO mandate, 12 Aug 2026:
// "expose the ElevenLabs voice tuning settings to the user … Stability,
// Similarity (Clarity), Style Exaggeration"). The knobs already exist in
// the agent's registry — ranges, clamping, per-model support, apply path,
// all tested there. THIS module decides what the studio renders from the
// broadcast: which entries become sliders, what value each shows, and
// when one is disabled with the model's own reason. Pure; the component
// only draws and commits.

// The CEO's three, in her order. speaker_boost/speed stay console-only —
// the studio surface is deliberately the taste controls, not the whole
// engine room.
export const TUNING_KNOB_NAMES = ['stability', 'similarity_boost', 'style'];

/**
 * Slider models from the agent's broadcast.
 * @param {Array<object>|null} metadata the ORDERED knob list (wire shape)
 * @param {object|null} config the agent's APPLIED config snapshot
 * @returns {Array<{name, label, hint, timing, lo, hi, step, value, disabledReason}>}
 */
export function tuningSliders(metadata, config) {
  if (!Array.isArray(metadata)) return [];
  const model = typeof config?.tts_model === 'string' ? config.tts_model : null;
  const out = [];
  for (const name of TUNING_KNOB_NAMES) {
    const entry = metadata.find((e) => e && e.name === name);
    if (!entry || entry.kind !== 'float') continue;
    const applied = config?.[name];
    out.push({
      name,
      label: entry.label ?? name,
      hint: entry.hint ?? null,
      timing: entry.timing ?? null,
      lo: entry.lo,
      hi: entry.hi,
      step: entry.step,
      // APPLIED truth first (the agent's snapshot), the registry default
      // only before any broadcast value exists — never an invented number.
      value: typeof applied === 'number' ? applied : (entry.default ?? entry.lo),
      // The model's own refusal, verbatim — a knob the current model
      // ignores renders disabled WITH the reason, never silently inert.
      disabledReason:
        model && entry.unsupported_models && entry.unsupported_models[model]
          ? entry.unsupported_models[model]
          : null,
    });
  }
  return out;
}
