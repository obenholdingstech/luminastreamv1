// The align slot, filled (ROADMAP §P3). framePipeline declared this stage as
// an inert passthrough named for its phase; this is the phase.
//
// Composition: elasticDelay (the policy — noisy audio-tail samples in, a
// stable video-delay target out) drives frameDelay (the mechanism — frames
// held until they have aged the target). One frameDelay instance per wrapped
// stream: apply() releases its predecessor before wrapping, so a restart can
// never leave an orphaned reader loop holding frames for a dead session.
//
// AUDIO IS THE MASTER CLOCK: this stage only ever delays video, and where
// the platform lacks insertable streams it is an honest passthrough —
// active:false, the readout keeps saying "sync pending".

import { createElasticDelay } from './elasticDelay.js';
import { createFrameDelay } from './frameDelay.js';

// What the video path itself costs: camera → Decart → decode → upscale →
// present. The mouth→ear measurement covers the AUDIO path only, so the
// delay applied to video is (mouth→ear − this) — the transformed frames
// already arrive this late on their own. Any fixed residual of the meter
// (output-stage buffering, analyser tap points) folds into the same number
// by construction.
//
// 700, not the original 300: CALIBRATED BY DRILL (CEO, 4 Aug 2026 evening) —
// with 300 the converted voice landed ~400ms ahead of the lips, meaning the
// video was being held ~400ms too long, meaning the real video leg costs
// ~400ms more than estimated. Runtime-trimmable (setVideoPathMs) so the next
// calibration is a knob press, not a deploy.
export const DEFAULT_VIDEO_PATH_MS = 700;

// The trim's guard rails: a video path can't be negative, and one claimed to
// exceed 2s would mean the estimate is broken, not the knob.
export const VIDEO_PATH_LIMITS = { min: 0, max: 2000 };

export function createAlignStage({
  elastic = createElasticDelay(),
  createDelay = (targetMs) => createFrameDelay({ targetMs }),
  videoPathMs = DEFAULT_VIDEO_PATH_MS,
} = {}) {
  let delay = null;
  let pathMs = videoPathMs;

  return {
    name: 'align',
    plannedIn: 'P3 — elastic A/V buffer',
    get active() {
      return Boolean(delay);
    },

    /** @param {{ kind: string, stream: MediaStream|null, width: number, height: number }} frames */
    apply(frames) {
      // One wrapped stream at a time — the predecessor's loops stop and its
      // held frames close BEFORE anything new starts.
      delay?.release();
      delay = null;
      if (!frames.stream) return frames;
      const next = createDelay(() => elastic.targetMs());
      if (!next.supported) return frames;
      delay = next;
      return { ...frames, stream: next.wrap(frames.stream) };
    },

    /**
     * One utterance's MEASURED mouth→ear delay (ms), from the sync meter —
     * the master clock, measured at the ear. The video path's own latency is
     * subtracted here: the frames already arrive that late for free.
     */
    observeMouthToEar(measuredMs) {
      if (!Number.isFinite(measuredMs)) return;
      elastic.observe(Math.max(0, measuredMs - pathMs));
    },

    /**
     * Live-trim the video-path estimate — the calibration knob. Clamped to
     * VIDEO_PATH_LIMITS; junk is refused, never applied. Applies from the
     * NEXT observation: the elastic's slew carries the picture there
     * smoothly, exactly as it does for a real latency change.
     */
    setVideoPathMs(ms) {
      if (!Number.isFinite(ms)) return;
      pathMs = Math.max(VIDEO_PATH_LIMITS.min, Math.min(VIDEO_PATH_LIMITS.max, ms));
    },

    videoPathMs() {
      return pathMs;
    },

    targetMs() {
      return elastic.targetMs();
    },

    /** Session over: stop loops, close held frames, forget the old clock. */
    release() {
      delay?.release();
      delay = null;
      elastic.reset();
    },

    describe() {
      return delay
        ? `align: elastic buffer live (target ${Math.round(elastic.targetMs())}ms — audio is the master clock)`
        : 'align: pass-through (P3 — elastic A/V buffer)';
    },
  };
}
