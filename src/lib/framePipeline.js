// The video render path, as a composable pipeline — never a raw <video> tag
// bolted to the screen.
//
// ROADMAP §P3 states the constraint this file exists to satisfy:
//
//   receive → align → upscale → present/publish
//
// Lucy outputs 720p, period (probe-verified). Enterprise fidelity to FHD/2K
// is OUR pipeline's job, client-side (the CEO's mandate, 3 Aug 2026):
// backend GPU upscaling was rejected on three doctrines at once — GPU-free
// stateless agents, lip-sync latency, and COGS. The stages below are the
// empty slots those later phases fill:
//
//   receive   the vendor's MediaStream (P2d — here)
//   align     P3's elastic A/V buffer, subscribing to the agent's live tail
//             latency. Audio is the master clock; video waits, never audio.
//   upscale   P3's WebGL FSR-class shader (<2ms/frame); P6's MetalFX in the
//             native lens, publishing 1080p/1440p while Decart bills 720p.
//   present   a <video> element today; the virtual camera at P6.
//
// Costs nothing now. Skipping it makes FHD a retrofit, which is exactly what
// "on our radar from day one" was meant to prevent.
//
// Every stage is a pure function of (frameSource, context) → frameSource, so
// a stage can be added, reordered, or removed without touching its
// neighbours, and each is testable without a browser. Today only `receive`
// and `present` are real; the middle two are declared, inert, and named so
// that adding them is filling a slot rather than restructuring a component.

/** @typedef {{ kind: string, stream: MediaStream|null, width: number, height: number }} Frames */

export const STAGES = ['receive', 'align', 'upscale', 'present'];

/** Lucy 2.5's fixed output — measured against the vendor's own docs. */
export const VENDOR_NATIVE = { width: 1280, height: 720 };

/** What the CEO's mandate targets. Declared here so the gap is visible. */
export const FIDELITY_TARGETS = {
  native: { width: 1280, height: 720, label: '720p (vendor native)' },
  fhd: { width: 1920, height: 1080, label: '1080p (FHD)' },
  qhd: { width: 2560, height: 1440, label: '1440p (2K)' },
};

/**
 * A stage that does nothing but declare itself — the honest form of "not yet
 * implemented". It passes frames through untouched and reports `active:false`,
 * so the UI can say "720p, upscale pending" rather than implying a capability
 * that does not exist.
 *
 * @param {string} name
 * @param {string} plannedIn
 */
export function passthroughStage(name, plannedIn) {
  return {
    name,
    active: false,
    plannedIn,
    /** @param {Frames} frames */
    apply: (frames) => frames,
    describe: () => `${name}: pass-through (${plannedIn})`,
  };
}

/**
 * Build the pipeline. `overrides` lets a later phase supply a real stage
 * without this module knowing anything about WebGL or MetalFX.
 *
 * @param {{ align?: any, upscale?: any }} [overrides]
 */
export function createFramePipeline(overrides = {}) {
  const stages = {
    // P3 — the elastic buffer. Named now because A/V sync must be able to
    // slot in without the video surface being rebuilt around it.
    align: overrides.align ?? passthroughStage('align', 'P3 — elastic A/V buffer'),
    // P3 (browser, WebGL) / P6 (native, MetalFX).
    upscale: overrides.upscale ?? passthroughStage('upscale', 'P3 — WebGL FSR-class'),
  };

  return {
    stages,

    /**
     * Run a vendor stream through the pipeline.
     * @param {MediaStream|null} stream
     * @returns {Frames}
     */
    run(stream) {
      /** @type {Frames} */
      let frames = {
        kind: 'receive',
        stream: stream ?? null,
        width: VENDOR_NATIVE.width,
        height: VENDOR_NATIVE.height,
      };
      frames = stages.align.apply(frames);
      frames = stages.upscale.apply(frames);
      return { ...frames, kind: 'present' };
    },

    /**
     * What the pipeline is actually delivering — for the UI, and for the
     * honesty rule: never claim a resolution a stage did not produce.
     */
    describe() {
      const upscaled = stages.upscale.active;
      return {
        vendorNative: VENDOR_NATIVE,
        delivering: upscaled
          ? stages.upscale.output ?? VENDOR_NATIVE
          : VENDOR_NATIVE,
        upscaleActive: upscaled,
        alignActive: stages.align.active,
        pending: STAGES.filter(
          (s) => (s === 'align' || s === 'upscale') && !stages[s].active,
        ).map((s) => stages[s].describe()),
      };
    },
  };
}
