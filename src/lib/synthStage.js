// The synthesize slot, filled (CEO directive, 5 Aug 2026): adaptive frame
// synthesis between align and upscale. Composition mirrors the other filled
// slots — frameSynthesis is the mechanism, the probe's renderers are the
// GPU, and this stage is the POLICY:
//
//   adopt()   the probe's verdict arrives (async — the stream may already be
//             flowing; the loop reads its mode live, so the tier simply
//             switches on)
//   demote()  the governor's verdict, or a mid-stream renderer failure:
//             motion → blend → off, each step disposing the renderer it
//             leaves behind. There is no runtime promotion.
//
// SYNC OUTRANKS SYNTHESIS, mechanically: every synthesized frame's render
// cost feeds a strike-counting governor; sustained overload demotes. A
// renderer that THROWS demotes on the spot. 'off' is a floor that cannot
// fail — the loop forwards frames untouched.
//
// Honesty: `tier` reports what is RUNNING, not what was hoped. The wrap is
// installed even while the tier is 'off' (the probe may still be running),
// but active/label only ever describe the current mode.

import { createFrameSynthesis } from './frameSynthesis.js';
import {
  TIER_BUDGET_MS,
  TIER_PLAN,
  createSynthGovernor,
  demotedTier,
} from './synthCapability.js';

export function createSynthStage({ createSynthesis = createFrameSynthesis } = {}) {
  const controller = { current: { targetFps: null, renderer: null } };
  /** @type {{ motion?: any, blend?: any }} */
  let renderers = {};
  let governor = null;
  let tier = 'off';
  let synthesis = null;
  let wrapped = false;
  const listeners = new Set();

  const notify = () => {
    for (const l of listeners) l(tier);
  };

  const enterTier = (next) => {
    tier = next;
    const plan = TIER_PLAN[tier];
    controller.current = {
      targetFps: plan.targetFps,
      renderer: tier === 'off' ? null : renderers[tier] ?? null,
    };
    // A tier without its renderer is a wish, not a mode.
    if (tier !== 'off' && !controller.current.renderer) {
      tier = 'off';
      controller.current = { targetFps: null, renderer: null };
    }
    governor =
      tier === 'off' ? null : createSynthGovernor({ budgetMs: TIER_BUDGET_MS[tier] });
    notify();
  };

  const demote = () => {
    const leaving = tier;
    const next = demotedTier(tier);
    renderers[leaving]?.dispose?.();
    delete renderers[leaving];
    enterTier(next);
  };

  return {
    name: 'synthesize',
    plannedIn: 'P3+ — adaptive frame synthesis',
    get active() {
      return wrapped && tier !== 'off';
    },
    get tier() {
      return tier;
    },
    get label() {
      return TIER_PLAN[tier].label;
    },

    /** UI subscription: tier changes need a re-render, not a poll. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The probe's verdict + its built renderers. Owns them from here on. */
    adopt({ tier: granted, renderers: built }) {
      renderers = built ?? {};
      enterTier(granted ?? 'off');
    },

    /** @param {{ kind: string, stream: MediaStream|null, width: number, height: number }} frames */
    apply(frames) {
      synthesis?.release();
      synthesis = null;
      wrapped = false;
      if (!frames.stream) return frames;
      const next = createSynthesis({
        controller,
        onSample: (ms) => {
          if (governor?.observe(ms) === 'demote') demote();
        },
        onRenderError: () => {
          // A throwing renderer forfeits its tier immediately — the loop
          // already forwarded the real frame, so the stream never blinked.
          if (tier !== 'off') demote();
        },
      });
      if (!next.supported) return frames; // no insertable streams — native is the truth
      const out = next.wrap(frames.stream);
      if (out === frames.stream) return frames;
      synthesis = next;
      wrapped = true;
      return { ...frames, stream: out };
    },

    release() {
      synthesis?.release();
      synthesis = null;
      wrapped = false;
      for (const r of Object.values(renderers)) r?.dispose?.();
      renderers = {};
      controller.current = { targetFps: null, renderer: null };
      governor = null;
      const wasOff = tier === 'off';
      tier = 'off';
      // Subscribers hear every tier transition — release included, or a UI
      // that outlives the stage keeps claiming the tier that just died.
      if (!wasOff) notify();
    },

    describe() {
      return tier === 'off'
        ? 'synthesize: pass-through (native rate is the truth)'
        : `synthesize: ${TIER_PLAN[tier].label} @ ${TIER_PLAN[tier].targetFps}fps target`;
    },
  };
}
