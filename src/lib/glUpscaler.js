// The WebGL2 renderer behind the upscale stage: one VideoFrame in, one
// bigger and sharper VideoFrame out.
//
// Browser-only by nature (OffscreenCanvas, WebGL2, VideoFrame) — which is
// exactly why it is INJECTED into frameUpscale rather than imported there
// unconditionally: the mechanism's lifecycle is tested in node with a fake
// renderer, and this file stays a thin, honest wrapper around the GPU.
// Construction THROWS where the platform cannot deliver; the caller treats
// that as "no upscale", never as a broken session.
//
// Ownership: render() returns a NEW frame built from the canvas and never
// closes its input — the caller owns both ends, one rule, no double-closes.

import {
  FRAGMENT_CAS,
  FRAGMENT_CATMULL_ROM,
  VERTEX_FULLSCREEN,
} from './upscaleShaders.js';

const DEFAULT_SHARPNESS = 0.35;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function program(gl, fragmentSource) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX_FULLSCREEN));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/**
 * @param {{
 *   source: { width: number, height: number },
 *   output: { width: number, height: number },
 *   sharpness?: number,
 *   OffscreenCanvasCtor?: any,
 *   VideoFrameCtor?: any,
 * }} cfg
 */
export function createGlUpscaler({
  source,
  output,
  sharpness = DEFAULT_SHARPNESS,
  OffscreenCanvasCtor = globalThis.OffscreenCanvas,
  VideoFrameCtor = globalThis.VideoFrame,
}) {
  if (typeof OffscreenCanvasCtor !== 'function' || typeof VideoFrameCtor !== 'function') {
    throw new Error('platform lacks OffscreenCanvas/VideoFrame');
  }
  const canvas = new OffscreenCanvasCtor(output.width, output.height);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error('webgl2 unavailable');

  const upsample = program(gl, FRAGMENT_CATMULL_ROM);
  const sharpen = program(gl, FRAGMENT_CAS);

  // Source texture (the incoming frame) and the intermediate FBO the
  // upsample pass renders into — both linear-filtered: pass 1's 9-tap trick
  // RELIES on bilinear fetches, and pass 2 samples texel centers anyway.
  const makeTexture = (w, h) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  };
  const sourceTex = makeTexture(0, 0);
  const midTex = makeTexture(output.width, output.height);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, midTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const uSrcSize = gl.getUniformLocation(upsample, 'srcSize');
  const uDstSize = gl.getUniformLocation(sharpen, 'dstSize');
  const uSharp = gl.getUniformLocation(sharpen, 'sharpness');

  let disposed = false;

  return {
    output,

    /**
     * One frame through both passes. Returns a NEW VideoFrame carrying the
     * input's timestamp; the input is untouched and stays the caller's.
     */
    render(frame) {
      if (disposed) throw new Error('upscaler disposed');
      gl.viewport(0, 0, output.width, output.height);

      // Pass 1: source frame → Catmull-Rom → intermediate texture.
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(upsample);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.uniform2f(uSrcSize, source.width, source.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 2: intermediate → CAS → canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(sharpen);
      gl.bindTexture(gl.TEXTURE_2D, midTex);
      gl.uniform2f(uDstSize, output.width, output.height);
      gl.uniform1f(uSharp, sharpness);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      return new VideoFrameCtor(canvas, { timestamp: frame.timestamp, alpha: 'discard' });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // context already lost
      }
    },
  };
}
