// The A/V sync policy (ROADMAP §P3): AUDIO IS THE MASTER CLOCK.
//
// The agent's voice arrives `tail` milliseconds after the words were spoken —
// a latency the agent itself measures and broadcasts per utterance. The
// transformed video arrives on its own clock. Sync means delaying VIDEO to
// stand beside the audio it belongs to; audio is never delayed, buffered, or
// waited for — a person hears themselves late enough already.
//
// The buffer must be ELASTIC (doctrine, measured at Stage 1): p95 tail in
// live conversation reaches ~1.9s and is STRUCTURAL — synthesized speech
// plays for about as long as it took to say, so continuous talking builds a
// backlog that drains at pauses. A fixed delay either desyncs under load or
// taxes every quiet moment. This module turns noisy tail samples into a
// STABLE video-delay target:
//
//   - windowed median (not mean: one cold-start outlier must not yank the
//     picture), over the last WINDOW samples;
//   - hysteresis: the target moves only when the median has drifted by more
//     than `deadbandMs` — sub-deadband jitter changes nothing;
//   - slew limiting: each adjustment moves at most `slewMs` toward the
//     median — the picture glides, it never jumps;
//   - clamped to [0, maxDelayMs]: video may never fall further behind than
//     the ceiling, whatever the audio does.
//
// Pure and injectable; the mechanism that holds actual frames lives beside
// it and asks only `targetMs()`.

export const ELASTIC_DEFAULTS = {
  window: 8, // utterances of memory — a few sentences of conversation
  deadbandMs: 120, // below this drift, do nothing (lip-sync tolerance ≈ ±120ms)
  slewMs: 250, // largest single glide
  maxDelayMs: 2000, // the structural p95, and the most video we will ever hold
};

export function createElasticDelay(overrides = {}) {
  const cfg = { ...ELASTIC_DEFAULTS, ...overrides };
  const samples = [];
  let target = 0;

  const median = () => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    /** One utterance's measured tail latency, in ms. Junk is ignored. */
    observe(tailMs) {
      if (!Number.isFinite(tailMs) || tailMs < 0) return;
      samples.push(Math.min(tailMs, cfg.maxDelayMs));
      if (samples.length > cfg.window) samples.shift();

      const goal = Math.min(median(), cfg.maxDelayMs);
      const drift = goal - target;
      if (Math.abs(drift) <= cfg.deadbandMs) return;
      target += Math.sign(drift) * Math.min(Math.abs(drift), cfg.slewMs);
      target = Math.max(0, Math.min(target, cfg.maxDelayMs));
    },

    /** How far behind real time the video should stand, right now. */
    targetMs() {
      return target;
    },

    /** A new session has a new clock — stale medians must not haunt it. */
    reset() {
      samples.length = 0;
      target = 0;
    },
  };
}
