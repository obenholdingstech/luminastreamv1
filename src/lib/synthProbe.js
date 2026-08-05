// The session-start capability benchmark (CEO directive, 5 Aug 2026): build
// each renderer, TIME it on real dummy frames, and let decideSynthTier grant
// the highest tier whose measured cost fits its budget. Presence of an API
// proves nothing — an iGPU can expose WebGPU and still miss a 10ms budget,
// which is exactly the machine the directive exists to protect.
//
// The probe KEEPS the built renderers and hands them to the stage: the
// motion→blend demotion path needs the blend renderer standing by, and
// rebuilding GPU state mid-session is work the session should not pay.
// Everything it built but the stage never adopts must be disposed by the
// caller via the returned handles.

import { createBlendRenderer } from './blendRenderer.js';
import { createMotionRenderer } from './motionRenderer.js';
import { decideSynthTier } from './synthCapability.js';
import { VENDOR_NATIVE } from './framePipeline.js';

const BENCH_ITERATIONS = 12;
const BENCH_WARMUP = 4;

/** Two frames with real gradient content — a flat frame would flatter the
 * motion search with degenerate early-outs the live stream never offers. */
function makeBenchFrames({ size, OffscreenCanvasCtor, VideoFrameCtor }) {
  const frames = [];
  for (let i = 0; i < 2; i++) {
    const canvas = new OffscreenCanvasCtor(size.width, size.height);
    const c2d = canvas.getContext('2d');
    const grad = c2d.createLinearGradient(i * 40, 0, size.width, size.height);
    grad.addColorStop(0, i ? '#c84' : '#48c');
    grad.addColorStop(1, i ? '#213' : '#132');
    c2d.fillStyle = grad;
    c2d.fillRect(0, 0, size.width, size.height);
    c2d.fillStyle = '#fff';
    c2d.fillRect(200 + i * 24, 200 + i * 12, 160, 160); // something that MOVES
    frames.push(new VideoFrameCtor(canvas, { timestamp: i * 52_600 }));
  }
  return frames;
}

async function bench(renderer, pair, now) {
  const [a, b] = pair;
  const times = [];
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    const t0 = now();
    const out = renderer.synthesize(a, b, 0.5, 26_300);
    await renderer.flush?.();
    times.push(now() - t0);
    out?.close?.();
  }
  const settled = times.slice(BENCH_WARMUP).sort((x, y) => x - y);
  return settled[Math.floor(settled.length / 2)];
}

/**
 * @param {{
 *   size?: { width: number, height: number },
 *   createMotion?: (args: any) => Promise<any>,
 *   createBlend?: (args: any) => any,
 *   OffscreenCanvasCtor?: any,
 *   VideoFrameCtor?: any,
 *   now?: () => number,
 * }} [deps]
 * @returns {Promise<{ tier: string, renderers: { motion: any, blend: any }, benches: { motionMs: number|null, blendMs: number|null } }>}
 */
export async function probeSynthCapability({
  size = VENDOR_NATIVE,
  createMotion = createMotionRenderer,
  createBlend = createBlendRenderer,
  OffscreenCanvasCtor = globalThis.OffscreenCanvas,
  VideoFrameCtor = globalThis.VideoFrame,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const renderers = { motion: null, blend: null };
  const benches = { motionMs: null, blendMs: null };

  let pair = null;
  try {
    pair = makeBenchFrames({ size, OffscreenCanvasCtor, VideoFrameCtor });
  } catch {
    // no canvas/VideoFrame at all — nothing to measure, nothing to grant
    return { tier: 'off', renderers, benches };
  }

  try {
    renderers.blend = createBlend({ size });
    benches.blendMs = await bench(renderers.blend, pair, now);
  } catch {
    renderers.blend?.dispose?.();
    renderers.blend = null;
  }
  try {
    renderers.motion = await createMotion({ size });
    benches.motionMs = await bench(renderers.motion, pair, now);
  } catch {
    renderers.motion?.dispose?.();
    renderers.motion = null;
  }
  for (const f of pair) f.close?.();

  const tier = decideSynthTier({
    motionBuilt: renderers.motion != null,
    motionBenchMs: benches.motionMs,
    blendBuilt: renderers.blend != null,
    blendBenchMs: benches.blendMs,
  });
  return { tier, renderers, benches };
}
