// The 'blend' tier renderer: one WebGL2 pass mixing two frames at weight t.
// Midpoint blending is honest about what it is — motion appears as a soft
// double-exposure rather than judder. It is the MID tier (CEO directive,
// 5 Aug 2026) because it costs almost nothing on any GPU that can run the
// upscaler at all, and it doubles 19fps to a visibly smoother 38.
//
// Same ownership contract as glUpscaler: synthesize() returns a NEW frame
// and never closes its inputs; construction THROWS where the platform
// cannot deliver, and the caller treats that as "no blend tier".

import { VERTEX_FULLSCREEN } from './upscaleShaders.js';

// Sampling at (uv.x, 1-uv.y) mirrors the upscaler's pass-1 flip: a frame
// uploaded via texImage2D lands inverted relative to the canvas VideoFrame
// readout, and exactly ONE flip must exist in any path from frame to frame.
const FRAGMENT_BLEND = `#version 300 es
precision highp float;
uniform sampler2D frameA;
uniform sampler2D frameB;
uniform float t;
in vec2 uv;
out vec4 color;
void main() {
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  color = mix(texture(frameA, p), texture(frameB, p), t);
}`;

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

/**
 * @param {{
 *   size: { width: number, height: number },
 *   OffscreenCanvasCtor?: any,
 *   VideoFrameCtor?: any,
 * }} cfg
 */
export function createBlendRenderer({
  size,
  OffscreenCanvasCtor = globalThis.OffscreenCanvas,
  VideoFrameCtor = globalThis.VideoFrame,
}) {
  if (typeof OffscreenCanvasCtor !== 'function' || typeof VideoFrameCtor !== 'function') {
    throw new Error('platform lacks OffscreenCanvas/VideoFrame');
  }
  const canvas = new OffscreenCanvasCtor(size.width, size.height);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error('webgl2 unavailable');

  // Construction failures after the context exists must not strand it —
  // a thrown factory returns nothing for the caller to dispose.
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_FULLSCREEN));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_BLEND));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
  } catch (err) {
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // context already lost
    }
    throw err;
  }

  const makeTexture = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  const texA = makeTexture();
  const texB = makeTexture();
  const uA = gl.getUniformLocation(program, 'frameA');
  const uB = gl.getUniformLocation(program, 'frameB');
  const uT = gl.getUniformLocation(program, 't');

  let disposed = false;

  return {
    kind: 'blend',

    /**
     * A new frame between a and b at weight t, stamped `timestamp`.
     * Inputs stay the caller's.
     */
    synthesize(a, b, t, timestamp) {
      if (disposed) throw new Error('blend renderer disposed');
      // A lost context turns every GL call into a silent no-op — the canvas
      // would keep yielding stale frames INSIDE budget, so the governor
      // would never demote. Throwing routes it to onRenderError, which does.
      if (gl.isContextLost?.()) throw new Error('blend renderer context lost');
      gl.viewport(0, 0, size.width, size.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.uniform1i(uA, 0);
      gl.uniform1i(uB, 1);
      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return new VideoFrameCtor(canvas, { timestamp, alpha: 'discard' });
    },

    /** Force the queue through — the bench needs honest wall time. */
    flush() {
      gl.finish();
      return Promise.resolve();
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
