// The frame-holding half of A/V sync (ROADMAP §P3), kept separate from the
// policy (elasticDelay.js) and from the browser glue (frameDelay.js) so the
// part that can leak memory or drop the wrong frame is testable in node.
//
// Frames are pushed as they arrive and become "ready" once they have aged
// `targetMs()`. Two hard rules:
//
//   - BOUNDED: past `maxFrames` the oldest frame is dropped AND CLOSED —
//     VideoFrames pin GPU memory, and an unbounded queue during a latency
//     spike is a browser crash with a delay attached;
//   - every dropped frame is closed exactly once, and frames handed out are
//     the caller's to close — ownership transfers on take.

export const DELAY_QUEUE_DEFAULTS = {
  // ~5s at 30fps — above the 4s policy ceiling (elasticDelay) with margin.
  // Worst case ≈ 150 × ~1.4MB of 720p frame ≈ 210MB, usually GPU-backed;
  // bounded is the promise, and overflow closes OLDEST so pathology presents
  // as video jumping forward, never as a browser out of memory.
  maxFrames: 150,
};

/**
 * @param {{ targetMs: () => number, now?: () => number, maxFrames?: number }} deps
 */
export function createDelayQueue({ targetMs, now = () => performance.now(), maxFrames = DELAY_QUEUE_DEFAULTS.maxFrames }) {
  /** @type {{ frame: any, at: number }[]} */
  const queue = [];
  let dropped = 0;

  return {
    /** A frame arrives. The queue owns it until take() or drop. */
    push(frame) {
      queue.push({ frame, at: now() });
      while (queue.length > maxFrames) {
        const oldest = queue.shift();
        try {
          oldest.frame.close?.();
        } catch {
          /* already closed */
        }
        dropped += 1;
      }
    },

    /**
     * Frames old enough to present, oldest first. Ownership transfers to the
     * caller — the queue will not close what it has handed out.
     */
    takeReady() {
      const ready = [];
      const cutoff = now() - targetMs();
      while (queue.length && queue[0].at <= cutoff) {
        ready.push(queue.shift().frame);
      }
      return ready;
    },

    /** Session over: close everything still held. */
    clear() {
      for (const { frame } of queue.splice(0)) {
        try {
          frame.close?.();
        } catch {
          /* already closed */
        }
      }
    },

    stats() {
      return { held: queue.length, dropped };
    },
  };
}
