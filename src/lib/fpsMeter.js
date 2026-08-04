// The frame-rate instrument (CEO 50fps mandate, 4 Aug 2026 — step one).
//
// Doctrine: instrument before tuning. Before any frame-synthesis stage
// exists, the page must SAY what rate the vendor actually delivers — the
// number was previously a guess ("Lucy does 20-25fps, roughly"), and a
// synthesis stage tuned against a guess would be tuned against nothing.
//
// Pure sliding-window rate math; the browser half (requestVideoFrameCallback
// on the presented element) lives in useFpsMeter and only feeds timestamps.
// The window is short enough to see a rate CHANGE (vendor under load)
// within a couple of seconds, long enough that one late frame is not a
// headline. Below minFrames the answer is null — "measuring", never a
// number invented from two frames.

export const FPS_METER_DEFAULTS = {
  windowMs: 2000,
  minFrames: 8,
};

export function createFpsMeter(overrides = {}) {
  const cfg = { ...FPS_METER_DEFAULTS, ...overrides };
  /** @type {number[]} */
  const times = [];

  const prune = (nowMs) => {
    while (times.length > 0 && nowMs - times[0] > cfg.windowMs) times.shift();
  };

  return {
    /** One presented frame, at tMs on the caller's clock. */
    frame(tMs) {
      if (!Number.isFinite(tMs)) return;
      // Out-of-order timestamps would make the span lie; a clock that
      // jumped backward starts a new measurement instead.
      if (times.length > 0 && tMs < times[times.length - 1]) times.length = 0;
      times.push(tMs);
      prune(tMs);
    },

    /**
     * Frames per second over the window, or null while measuring. Pruned
     * against the CALLER'S now, not the last frame's: a stream that stopped
     * presenting must decay to null within one window — a frozen stream
     * still reporting yesterday's rate is the fps meter's version of the
     * zombie the canon forbids.
     */
    read(nowMs) {
      if (Number.isFinite(nowMs)) prune(nowMs);
      if (times.length < cfg.minFrames) return null;
      const span = times[times.length - 1] - times[0];
      if (span <= 0) return null;
      return Math.round(((times.length - 1) * 1000) / span);
    },

    reset() {
      times.length = 0;
    },
  };
}
