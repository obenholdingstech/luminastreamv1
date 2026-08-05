// The 'motion' tier renderer: true motion-compensated interpolation in
// WebGPU. Three passes per frame pair:
//
//   1. luma downsample  both frames → 1/4-resolution luma planes
//   2. block match      full search ±7 luma px per 16×16-luma tile (≈ ±28
//                       full-res px) → a coarse forward motion field A→B
//   3. warp + blend     each output pixel samples A backward and B forward
//                       along its tile's motion; where the two warped
//                       samples disagree (occlusion, bad match) the pixel
//                       falls back to a plain crossfade — a WRONG motion
//                       vector must degrade to blend-tier quality, never to
//                       smearing artifacts
//
// The GPU drill (4 Aug) put RIFE-class synthesis at 7–15ms on a discrete
// GPU; this coarse classical pipeline is far lighter, which is what gives
// mid-range hardware a chance at the top tier. The probe measures rather
// than guesses (CEO directive: capability is checked, not assumed).
//
// Ownership contract matches glUpscaler: synthesize() returns a NEW frame,
// never closes inputs. The factory is ASYNC (adapter/device negotiation)
// and THROWS where WebGPU cannot deliver; a lost device makes synthesize()
// throw, which the synthesis loop treats as "forward the real frame" and
// the stage treats as a demotion — the stream survives the GPU.

const LUMA_SCALE = 4; // motion is estimated at 1/4 resolution
const TILE = 16; //      luma pixels per motion tile
const SEARCH = 7; //     ± luma pixels of full search

function shaders({ srcW, srcH, lumaW, lumaH, gridW, gridH }) {
  const common = `
const SRC_SIZE = vec2f(${srcW}.0, ${srcH}.0);
const LUMA_SIZE = vec2i(${lumaW}, ${lumaH});
const GRID_SIZE = vec2i(${gridW}, ${gridH});
`;

  const downsample = `${common}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u32(LUMA_SIZE.x) || gid.y >= u32(LUMA_SIZE.y)) { return; }
  var sum = 0.0;
  for (var dy = 0; dy < ${LUMA_SCALE}; dy++) {
    for (var dx = 0; dx < ${LUMA_SCALE}; dx++) {
      let p = vec2i(gid.xy) * ${LUMA_SCALE} + vec2i(dx, dy);
      let c = textureLoad(src, min(p, vec2i(${srcW - 1}, ${srcH - 1})), 0);
      sum += dot(c.rgb, vec3f(0.299, 0.587, 0.114));
    }
  }
  textureStore(dst, vec2i(gid.xy), vec4f(sum / ${LUMA_SCALE * LUMA_SCALE}.0, 0, 0, 1));
}`;

  const candidates = 2 * SEARCH + 1; // 15 per axis

  const blockMatch = `${common}
@group(0) @binding(0) var lumaA: texture_2d<f32>;
@group(0) @binding(1) var lumaB: texture_2d<f32>;
@group(0) @binding(2) var motion: texture_storage_2d<rg32float, write>;

var<workgroup> sads: array<f32, ${candidates * candidates}>;

fn lumaAt(t: texture_2d<f32>, p: vec2i) -> f32 {
  return textureLoad(t, clamp(p, vec2i(0), LUMA_SIZE - 1), 0).r;
}

@compute @workgroup_size(${candidates}, ${candidates})
fn main(@builtin(workgroup_id) tile: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let base = vec2i(tile.xy) * ${TILE};
  let offset = vec2i(lid.xy) - ${SEARCH};
  // SAD on a 2x-subsampled block: quality of a coarse field, quarter the loads.
  var sad = 0.0;
  for (var y = 0; y < ${TILE}; y += 2) {
    for (var x = 0; x < ${TILE}; x += 2) {
      let p = base + vec2i(x, y);
      sad += abs(lumaAt(lumaA, p) - lumaAt(lumaB, p + offset));
    }
  }
  // Zero-motion bias: prefer stillness on ties/noise so flat regions never
  // acquire junk vectors that the warp would then trust.
  if (any(offset != vec2i(0))) { sad += 0.003; }
  sads[lid.y * ${candidates}u + lid.x] = sad;
  workgroupBarrier();

  if (lid.x == 0u && lid.y == 0u) {
    var best = 0u;
    var bestSad = sads[0];
    for (var i = 1u; i < ${candidates * candidates}u; i++) {
      if (sads[i] < bestSad) { bestSad = sads[i]; best = i; }
    }
    let bv = vec2f(f32(best % ${candidates}u) - ${SEARCH}.0,
                   f32(best / ${candidates}u) - ${SEARCH}.0);
    textureStore(motion, vec2i(tile.xy), vec4f(bv * ${LUMA_SCALE}.0, 0, 1));
  }
}`;

  const warp = `${common}
struct Params { t: f32 }
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var motion: texture_2d<f32>;
@group(0) @binding(4) var<uniform> params: Params;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vmain(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

fn motionAt(g: vec2i) -> vec2f {
  return textureLoad(motion, clamp(g, vec2i(0), GRID_SIZE - 1), 0).rg;
}

@fragment
fn fmain(in: VOut) -> @location(0) vec4f {
  // Manual bilinear over the tiny motion grid (float32 textures are not
  // universally filterable; the grid is 20x12 — four loads cost nothing).
  let gpos = in.uv * vec2f(GRID_SIZE) - 0.5;
  let g0 = vec2i(floor(gpos));
  let f = fract(gpos);
  let v = mix(
    mix(motionAt(g0), motionAt(g0 + vec2i(1, 0)), f.x),
    mix(motionAt(g0 + vec2i(0, 1)), motionAt(g0 + vec2i(1, 1)), f.x),
    f.y,
  );
  let duv = v / SRC_SIZE;
  let t = params.t;
  let a = textureSampleLevel(srcA, samp, in.uv - duv * t, 0.0);
  let b = textureSampleLevel(srcB, samp, in.uv + duv * (1.0 - t), 0.0);
  let warped = mix(a, b, t);
  let direct = mix(textureSampleLevel(srcA, samp, in.uv, 0.0),
                   textureSampleLevel(srcB, samp, in.uv, 0.0), t);
  // Where the two motion-warped samples disagree the vector is lying
  // (occlusion, search miss) — fade that pixel back to the plain crossfade.
  let disagreement = distance(a.rgb, b.rgb);
  let fallback = smoothstep(0.18, 0.45, disagreement);
  return vec4f(mix(warped, direct, fallback).rgb, 1.0);
}`;

  return { downsample, blockMatch, warp };
}

/**
 * @param {{
 *   size: { width: number, height: number },
 *   gpu?: any,
 *   OffscreenCanvasCtor?: any,
 *   VideoFrameCtor?: any,
 * }} cfg
 */
export async function createMotionRenderer({
  size,
  gpu = /** @type {any} */ (globalThis.navigator)?.gpu,
  OffscreenCanvasCtor = globalThis.OffscreenCanvas,
  VideoFrameCtor = globalThis.VideoFrame,
}) {
  if (!gpu || typeof OffscreenCanvasCtor !== 'function' || typeof VideoFrameCtor !== 'function') {
    throw new Error('platform lacks WebGPU/OffscreenCanvas/VideoFrame');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();

  const srcW = size.width;
  const srcH = size.height;
  const lumaW = Math.ceil(srcW / LUMA_SCALE);
  const lumaH = Math.ceil(srcH / LUMA_SCALE);
  const gridW = Math.ceil(lumaW / TILE);
  const gridH = Math.ceil(lumaH / TILE);
  const code = shaders({ srcW, srcH, lumaW, lumaH, gridW, gridH });

  // Everything below can throw AFTER the device exists (context refusal,
  // validation, exotic drivers) — and a throwing factory returns nothing
  // for the caller to dispose, so the device must not outlive the failure.
  let R;
  try {
    R = (() => {
      const canvas = new OffscreenCanvasCtor(srcW, srcH);
      const ctx = canvas.getContext('webgpu');
      if (!ctx) throw new Error('webgpu canvas context unavailable');
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });

      const tex = (w, h, fmt, usage) => device.createTexture({ size: [w, h], format: fmt, usage });
      // Spec-fixed numeric usage flags (this module is typed without WebGPU lib
      // types): COPY_DST 0x2, TEXTURE_BINDING 0x4, STORAGE_BINDING 0x8,
      // RENDER_ATTACHMENT 0x10.
      const U = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 };
      const srcA = tex(srcW, srcH, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING | U.RENDER_ATTACHMENT);
      const srcB = tex(srcW, srcH, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING | U.RENDER_ATTACHMENT);
      const lumaA = tex(lumaW, lumaH, 'r32float', U.STORAGE_BINDING | U.TEXTURE_BINDING);
      const lumaB = tex(lumaW, lumaH, 'r32float', U.STORAGE_BINDING | U.TEXTURE_BINDING);
      const motionTex = tex(gridW, gridH, 'rg32float', U.STORAGE_BINDING | U.TEXTURE_BINDING);

      const module = (c) => device.createShaderModule({ code: c });
      const downPipe = device.createComputePipeline({
        layout: 'auto',
        compute: { module: module(code.downsample), entryPoint: 'main' },
      });
      const matchPipe = device.createComputePipeline({
        layout: 'auto',
        compute: { module: module(code.blockMatch), entryPoint: 'main' },
      });
      const warpModule = module(code.warp);
      const warpPipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: warpModule, entryPoint: 'vmain' },
        fragment: { module: warpModule, entryPoint: 'fmain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });

      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      // Numeric usage flags, not the GPUBufferUsage global: this module is typed
      // without WebGPU lib types, and the constants are spec-fixed values
      // (UNIFORM = 0x40, COPY_DST = 0x8).
      const params = device.createBuffer({ size: 16, usage: 0x40 | 0x8 });

      const downBindA = device.createBindGroup({
        layout: downPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcA.createView() },
          { binding: 1, resource: lumaA.createView() },
        ],
      });
      const downBindB = device.createBindGroup({
        layout: downPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcB.createView() },
          { binding: 1, resource: lumaB.createView() },
        ],
      });
      const matchBind = device.createBindGroup({
        layout: matchPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: lumaA.createView() },
          { binding: 1, resource: lumaB.createView() },
          { binding: 2, resource: motionTex.createView() },
        ],
      });
      const warpBind = device.createBindGroup({
        layout: warpPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcA.createView() },
          { binding: 1, resource: srcB.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: motionTex.createView() },
          { binding: 4, resource: { buffer: params } },
        ],
      });
      return { ctx, srcA, srcB, downPipe, matchPipe, warpPipe, sampler, params, downBindA, downBindB, matchBind, warpBind, canvas };
    })();
  } catch (err) {
    try {
      device.destroy();
    } catch {
      // device already lost
    }
    throw err;
  }
  const { ctx, srcA, srcB, downPipe, matchPipe, warpPipe, params, downBindA, downBindB, matchBind, warpBind, canvas } = R;

  let disposed = false;
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });

  // The synthesis loop calls synthesize() (factor-1) times per PAIR; upload
  // and motion search run once per pair, keyed on input identity.
  let lastA = null;
  let lastB = null;

  return {
    kind: 'motion',

    synthesize(a, b, t, timestamp) {
      if (disposed || lost) throw new Error('motion renderer unavailable');
      const newPair = a !== lastA || b !== lastB;
      if (newPair) {
        device.queue.copyExternalImageToTexture({ source: a }, { texture: srcA }, [srcW, srcH]);
        device.queue.copyExternalImageToTexture({ source: b }, { texture: srcB }, [srcW, srcH]);
        lastA = a;
        lastB = b;
      }
      device.queue.writeBuffer(params, 0, new Float32Array([t, 0, 0, 0]));

      const enc = device.createCommandEncoder();
      if (newPair) {
        const down = enc.beginComputePass();
        down.setPipeline(downPipe);
        down.setBindGroup(0, downBindA);
        down.dispatchWorkgroups(Math.ceil(lumaW / 8), Math.ceil(lumaH / 8));
        down.setBindGroup(0, downBindB);
        down.dispatchWorkgroups(Math.ceil(lumaW / 8), Math.ceil(lumaH / 8));
        down.end();
        const match = enc.beginComputePass();
        match.setPipeline(matchPipe);
        match.setBindGroup(0, matchBind);
        match.dispatchWorkgroups(gridW, gridH);
        match.end();
      }
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(warpPipe);
      pass.setBindGroup(0, warpBind);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);

      return new VideoFrameCtor(canvas, { timestamp, alpha: 'discard' });
    },

    /** Wait out the queue — the bench needs honest wall time. */
    flush() {
      return device.queue.onSubmittedWorkDone();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      lastA = null;
      lastB = null;
      try {
        device.destroy();
      } catch {
        // device already lost
      }
    },
  };
}
