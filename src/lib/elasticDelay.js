// The A/V sync policy (ROADMAP §P3): AUDIO IS THE MASTER CLOCK.
//
// RETARGETED 4 Aug 2026: the samples fed here are now the MEASURED mouth→ear
// delay (syncMeter.js — local mic onset to remote voice onset, one browser
// clock), minus the video path's own latency (alignStage). The previous diet
// was the agent's tail_latency_ms, which misses the utterance's own duration,
// playback backlog, and the network — the measured 5/10 "inconsistent" sync.
// The mechanism below was right all along; it was listening to the wrong
// number.
//
// Sync means delaying VIDEO to stand beside the audio it belongs to; audio
// is never delayed, buffered, or waited for — a person hears themselves late
// enough already.
//
// The buffer must be ELASTIC (doctrine, measured at Stage 1): backlog is
// STRUCTURAL — synthesized speech plays for about as long as it took to say,
// so continuous talking builds a queue that drains at pauses. A fixed delay
// either desyncs under load or taxes every quiet moment. This module turns
// noisy delay samples into a STABLE video-delay target:
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
  // Measured mouth→ear samples are ground truth, not a proxy — less memory
  // is needed to trust them, and less memory converges faster at session
  // start and tracks backlog swings sooner.
  window: 5,
  deadbandMs: 120, // below this drift, do nothing (lip-sync tolerance ≈ ±120ms)
  slewMs: 400, // largest single glide — reaches a 1.5s truth in ~4 utterances
  // Mouth→ear regularly exceeds the old 2s ceiling by construction: it
  // contains the utterance's own duration plus tail plus backlog. 4s covers
  // the observed range; delayQueue's frame bound (150 frames ≈ 5s at 30fps)
  // stands above it with margin, closing oldest on overflow.
  maxDelayMs: 4000,
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
