// The tier decision for client-side frame synthesis (CEO directive, 5 Aug
// 2026): hardware variance is real, so capability is MEASURED per device at
// session start, never assumed.
//
//   motion  WebGPU motion-compensated interpolation, native ×3 → ~57fps
//   blend   WebGL2 midpoint blending, native ×2 → ~38fps
//   off     the native stream untouched — bulletproof sync, zero added work
//
// Two rules with teeth:
//
// PROOF, NOT PRESENCE. A tier is granted only when its renderer BUILT and
// its measured bench fits the budget. Missing bench, failed build, absent
// API — every unknown falls toward 'off'. The lens must work on a weak
// laptop before it gets to be pretty on a strong one.
//
// SYNC OUTRANKS SYNTHESIS (the CEO's standing rule). Granting a tier at
// start is a hypothesis; the governor below watches real per-frame cost for
// the whole session and DEMOTES on sustained overload — motion → blend →
// off. There is no runtime re-promotion: a machine that failed under load
// once does not get to retry this session with someone's call on the line.
//
// The rendered-frame budget is a fraction of the output frame interval, not
// all of it: the same GPU also runs the upscaler, the page, and the encode.

export const SYNTH_TIERS = ['motion', 'blend', 'off'];

/** Native delivered rate the multipliers act on (instrument-measured). */
export const NATIVE_FPS = 19;

export const TIER_PLAN = {
  motion: { factor: 3, label: 'synthesized · motion' }, // 19 → 57fps
  blend: { factor: 2, label: 'synthesized · blend' }, //   19 → 38fps
  off: { factor: 1, label: null },
};

// Budget = output interval × 0.6 (headroom for upscale + page + encode).
// motion: 1000/57 × 0.6 ≈ 10.5ms; blend: 1000/38 × 0.6 ≈ 15.8ms.
export const TIER_BUDGET_MS = {
  motion: Math.round(((1000 / (NATIVE_FPS * TIER_PLAN.motion.factor)) * 0.6) * 10) / 10,
  blend: Math.round(((1000 / (NATIVE_FPS * TIER_PLAN.blend.factor)) * 0.6) * 10) / 10,
};

/**
 * The session-start decision. Everything optional, everything defaulting to
 * refusal: a tier requires its renderer built AND its bench inside budget.
 *
 * @param {{
 *   motionBuilt?: boolean, motionBenchMs?: number|null,
 *   blendBuilt?: boolean, blendBenchMs?: number|null,
 * }} probe
 * @returns {'motion'|'blend'|'off'}
 */
export function decideSynthTier({
  motionBuilt = false,
  motionBenchMs = null,
  blendBuilt = false,
  blendBenchMs = null,
} = {}) {
  if (motionBuilt && Number.isFinite(motionBenchMs) && motionBenchMs <= TIER_BUDGET_MS.motion) {
    return 'motion';
  }
  if (blendBuilt && Number.isFinite(blendBenchMs) && blendBenchMs <= TIER_BUDGET_MS.blend) {
    return 'blend';
  }
  return 'off';
}

/** The next tier down. 'off' is the floor and demotes to itself — and an
 * UNKNOWN tier lands on the floor too: indexOf's -1 would otherwise wrap to
 * index 0 and "demote" nonsense straight to the top tier. */
export function demotedTier(tier) {
  const i = SYNTH_TIERS.indexOf(tier);
  if (i < 0) return 'off';
  return SYNTH_TIERS[Math.min(i + 1, SYNTH_TIERS.length - 1)];
}

export const GOVERNOR_DEFAULTS = {
  // ~1s of mostly-over-budget frames demotes; a lone GC spike does not:
  // each good frame pays down two strikes, so demotion needs SUSTAINED
  // overload, not a bad moment.
  demoteAtStrikes: 20,
  goodFramePaysStrikes: 2,
};

/**
 * The runtime enforcer of "sync outranks synthesis". Feed it the measured
 * per-output-frame render cost; it answers whether the current tier keeps
 * its grant. Pure state machine — no clocks, no browser.
 *
 * @param {{ budgetMs: number, demoteAtStrikes?: number, goodFramePaysStrikes?: number }} cfg
 */
export function createSynthGovernor({
  budgetMs,
  demoteAtStrikes = GOVERNOR_DEFAULTS.demoteAtStrikes,
  goodFramePaysStrikes = GOVERNOR_DEFAULTS.goodFramePaysStrikes,
}) {
  let strikes = 0;
  let demoted = false;

  return {
    /**
     * One rendered frame's cost. Returns 'demote' exactly once, at the
     * moment the grant is lost; 'ok' otherwise.
     */
    observe(renderMs) {
      if (demoted) return 'demoted';
      if (!Number.isFinite(renderMs)) return 'ok'; // junk measures convict nobody
      if (renderMs > budgetMs) {
        strikes += 1;
        if (strikes >= demoteAtStrikes) {
          demoted = true;
          return 'demote';
        }
      } else {
        strikes = Math.max(0, strikes - goodFramePaysStrikes);
      }
      return 'ok';
    },
    get strikes() {
      return strikes;
    },
    get demoted() {
      return demoted;
    },
  };
}
