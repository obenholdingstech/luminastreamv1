// The GLSL half of the upscale stage (ROADMAP §P3: "WebGL FSR-class").
//
// Two passes, because sharpening needs the upsampled neighborhood:
//
//   pass 1 — Catmull-Rom bicubic upsample, the 9-tap optimized form
//            (bilinear-weighted taps stand in for the full 16): 720p pixels
//            become 1080p pixels with edges intact instead of bilinear mush;
//   pass 2 — CAS, AMD's contrast-adaptive sharpen (the mathematics of
//            FidelityFX CAS, simplified): each pixel is sharpened by exactly
//            as much as its local contrast can absorb, so edges crisp up
//            while flat skin does not turn to noise.
//
// Plain exported strings: node can assert their shape without a GPU, and the
// renderer (glUpscaler.js) is the only thing that ever compiles them.
//
// Orientation: video texel row 0 is the image's TOP; GL displays framebuffer
// row 0 at the BOTTOM. One net vertical flip makes the output upright — it
// lives in pass 1's sample coordinate, and pass 2 is identity. Move a pass,
// keep the parity.

export const VERTEX_FULLSCREEN = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  // A single fullscreen triangle from gl_VertexID — no buffers to manage.
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_CATMULL_ROM = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 srcSize;
in vec2 uv;
out vec4 color;

vec4 catmullRom(vec2 coord) {
  vec2 samplePos = coord * srcSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;

  vec2 texPos0 = (texPos1 - 1.0) / srcSize;
  vec2 texPos3 = (texPos1 + 2.0) / srcSize;
  vec2 texPos12 = (texPos1 + offset12) / srcSize;

  vec4 result = vec4(0.0);
  result += texture(src, vec2(texPos0.x, texPos0.y)) * w0.x * w0.y;
  result += texture(src, vec2(texPos12.x, texPos0.y)) * w12.x * w0.y;
  result += texture(src, vec2(texPos3.x, texPos0.y)) * w3.x * w0.y;
  result += texture(src, vec2(texPos0.x, texPos12.y)) * w0.x * w12.y;
  result += texture(src, vec2(texPos12.x, texPos12.y)) * w12.x * w12.y;
  result += texture(src, vec2(texPos3.x, texPos12.y)) * w3.x * w12.y;
  result += texture(src, vec2(texPos0.x, texPos3.y)) * w0.x * w3.y;
  result += texture(src, vec2(texPos12.x, texPos3.y)) * w12.x * w3.y;
  result += texture(src, vec2(texPos3.x, texPos3.y)) * w3.x * w3.y;
  return result;
}

void main() {
  // The one vertical flip (see header).
  color = vec4(catmullRom(vec2(uv.x, 1.0 - uv.y)).rgb, 1.0);
}
`;

export const FRAGMENT_CAS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 dstSize;
uniform float sharpness; // 0..1 — how hard CAS may push where contrast allows
in vec2 uv;
out vec4 color;

void main() {
  vec2 px = 1.0 / dstSize;
  vec3 e = texture(src, uv).rgb;
  vec3 n = texture(src, uv + vec2(0.0, -px.y)).rgb;
  vec3 s = texture(src, uv + vec2(0.0, px.y)).rgb;
  vec3 w = texture(src, uv + vec2(-px.x, 0.0)).rgb;
  vec3 r = texture(src, uv + vec2(px.x, 0.0)).rgb;

  vec3 mn = min(min(min(n, s), min(w, r)), e);
  vec3 mx = max(max(max(n, s), max(w, r)), e);

  // How much sharpening this neighborhood can absorb: the headroom between
  // its darkest and brightest members, normalized. Flat regions -> ~0.
  vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0);

  // AMD's developer knob mapping: peak negative lobe between -1/8 and -1/5.
  float peak = mix(-0.125, -0.2, clamp(sharpness, 0.0, 1.0));
  vec3 wgt = sqrt(amp) * peak;

  vec3 sharpened = (e + (n + s + w + r) * wgt) / (1.0 + 4.0 * wgt);
  color = vec4(clamp(sharpened, 0.0, 1.0), 1.0);
}
`;
