// Avatar pick compression (CEO mandate, 11 Aug 2026): the picker accepts
// up to 15MB, but the vendor's live-reference wall is ~5MB of base64 — so
// the browser walks a quality/dimension ladder until the image fits, and
// what's stored/sent is always vendor-usable. The LADDER and the walk are
// pure (the encoder is injected); the browser wrapper below binds canvas.

export const AVATAR_PICK_MAX_BYTES = 15 * 1024 * 1024;
// Decart wants the reference under ~5MB as base64; 3.5MB of bytes inflates
// to just under that (the original 3.5MB gate's own math, kept as the
// TARGET rather than the refusal).
export const AVATAR_TARGET_BYTES = 3.5 * 1024 * 1024;

/** Largest-first: try near-native quality, then shrink. Pure. */
export function compressionLadder() {
  return [
    { maxDim: 4096, quality: 0.92 },
    { maxDim: 2048, quality: 0.9 },
    { maxDim: 2048, quality: 0.8 },
    { maxDim: 1600, quality: 0.8 },
    { maxDim: 1280, quality: 0.75 },
    { maxDim: 1024, quality: 0.7 },
  ];
}

/**
 * Walk the ladder with an injected encoder until the result fits.
 * `encode({maxDim, quality}) → Promise<{ bytes: number, dataUrl: string }>`.
 * Returns the first fitting rung, or the smallest attempt if none fit
 * (the server wall still guards — we never send something we know is over).
 */
export async function compressToTarget(encode, target = AVATAR_TARGET_BYTES) {
  let smallest = null;
  for (const rung of compressionLadder()) {
    const out = await encode(rung);
    if (!smallest || out.bytes < smallest.bytes) smallest = out;
    if (out.bytes <= target) return { ...out, fitted: true };
  }
  return smallest ? { ...smallest, fitted: false } : null;
}

/** The browser encoder: file → bitmap → canvas at maxDim → JPEG dataUrl. */
export async function browserCompressImage(file, target = AVATAR_TARGET_BYTES) {
  const bitmap = await createImageBitmap(file);
  try {
    const encode = async ({ maxDim, quality }) => {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      // base64 length → decoded bytes (the wall thinks in decoded bytes)
      const b64 = dataUrl.split(',')[1] ?? '';
      return { bytes: Math.floor((b64.length * 3) / 4), dataUrl };
    };
    return await compressToTarget(encode, target);
  } finally {
    bitmap.close?.();
  }
}
