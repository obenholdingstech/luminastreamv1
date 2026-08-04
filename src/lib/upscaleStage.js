// The upscale slot, filled (ROADMAP §P3). framePipeline declared this stage
// as an inert passthrough named for its phase; this is the phase.
//
// Composition mirrors alignStage exactly: frameUpscale (the mechanism —
// insertable-streams loop, honest passthrough) is driven by glUpscaler (the
// GPU: Catmull-Rom upsample + CAS sharpen), and one instance exists per
// wrapped stream so a restart can never leave an orphaned loop holding a GL
// context for a dead session.
//
// Honesty is structural: `active` reports whether wrap() actually returned
// a DIFFERENT stream. A missing platform, a failed GL context — either way
// the original stream flows on and the readout keeps saying 720p, because
// claiming a resolution a stage did not produce is the lie this pipeline
// was built to make impossible.

import { createFrameUpscale } from './frameUpscale.js';
import { createGlUpscaler } from './glUpscaler.js';
import { FIDELITY_TARGETS } from './framePipeline.js';

export function createUpscaleStage({
  target = FIDELITY_TARGETS.fhd,
  createUpscale = (args) =>
    createFrameUpscale({ ...args, createRenderer: (r) => createGlUpscaler(r) }),
} = {}) {
  let upscale = null;
  let activeNow = false;

  return {
    name: 'upscale',
    plannedIn: 'P3 — WebGL FSR-class',
    get active() {
      return activeNow;
    },
    get output() {
      return { width: target.width, height: target.height };
    },

    /** @param {{ kind: string, stream: MediaStream|null, width: number, height: number }} frames */
    apply(frames) {
      upscale?.release();
      upscale = null;
      activeNow = false;
      if (!frames.stream) return frames;
      const next = createUpscale({
        source: { width: frames.width, height: frames.height },
        output: { width: target.width, height: target.height },
      });
      if (!next.supported) return frames;
      const wrapped = next.wrap(frames.stream);
      if (wrapped === frames.stream) return frames; // renderer refused — 720p is the truth
      upscale = next;
      activeNow = true;
      return { ...frames, stream: wrapped, width: target.width, height: target.height };
    },

    /** Session over: stop the loop, lose the GL context. */
    release() {
      upscale?.release();
      upscale = null;
      activeNow = false;
    },

    describe() {
      return activeNow
        ? `upscale: ${target.label} live (Catmull-Rom + CAS, vendor stays 720p)`
        : 'upscale: pass-through (P3 — WebGL FSR-class)';
    },
  };
}
