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

export function createAlignStage({
  elastic = createElasticDelay(),
  createDelay = (targetMs) => createFrameDelay({ targetMs }),
} = {}) {
  let delay = null;

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

    /** One utterance's agent-measured tail latency (ms) — the master clock. */
    observeTail(tailMs) {
      elastic.observe(tailMs);
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
