// The browser glue for A/V sync (ROADMAP §P3): insertable streams.
//
// MediaStreamTrackProcessor exposes the vendor's decoded VideoFrames as a
// readable; MediaStreamTrackGenerator turns frames back into a track. Between
// them sits the delayQueue, holding each frame until it has aged the elastic
// target — video stands beside the audio it belongs to, and AUDIO IS NEVER
// TOUCHED: the stream's audio tracks (there are none today; the agent's voice
// travels via LiveKit) pass through untouched by construction.
//
// Everything is injected so the two loops can be tested with fake tracks in
// node; the platform classes are Chrome-only (the drill canon is real Chrome
// already), and where they are missing `wrap` is an HONEST PASSTHROUGH — the
// stage reports active:false and the readout keeps saying "sync pending"
// rather than pretending.

import { createDelayQueue } from './delayQueue.js';

/**
 * @param {{
 *   targetMs: () => number,
 *   Processor?: any,
 *   Generator?: any,
 *   StreamCtor?: any,
 *   now?: () => number,
 *   tickMs?: number,
 *   maxFrames?: number,
 * }} deps
 */
export function createFrameDelay({
  targetMs,
  Processor = globalThis.MediaStreamTrackProcessor,
  Generator = globalThis.MediaStreamTrackGenerator,
  StreamCtor = globalThis.MediaStream,
  now = () => performance.now(),
  tickMs = 10,
  maxFrames,
}) {
  const supported = typeof Processor === 'function' && typeof Generator === 'function';
  let queue = null;
  let running = false;

  return {
    get supported() {
      return supported;
    },

    /**
     * Wrap a vendor stream: same audio tracks, video delayed by targetMs().
     * Unsupported platforms get the original stream back, untouched.
     */
    wrap(stream) {
      if (!supported || !stream) return stream;
      const [videoTrack] = stream.getVideoTracks?.() ?? [];
      if (!videoTrack) return stream;

      const processor = new Processor({ track: videoTrack });
      const generator = new Generator({ kind: 'video' });
      queue = createDelayQueue({ targetMs, now, ...(maxFrames ? { maxFrames } : {}) });
      running = true;

      // Reader loop: pull frames as fast as they decode — NEVER block the
      // processor (a blocked processor drops upstream frames and the delay
      // would silently present stale-then-jumping video).
      (async () => {
        const reader = processor.readable.getReader();
        try {
          while (running) {
            const { value, done } = await reader.read();
            if (done) break;
            if (running) queue.push(value);
            else value.close?.();
          }
        } catch {
          /* track ended */
        } finally {
          reader.releaseLock?.();
        }
      })();

      // Writer loop: present everything that has aged the target, in order.
      (async () => {
        const writer = generator.writable.getWriter();
        try {
          while (running) {
            for (const frame of queue.takeReady()) {
              await writer.write(frame);
            }
            await new Promise((r) => setTimeout(r, tickMs));
          }
        } catch {
          /* generator closed */
        } finally {
          try {
            writer.releaseLock?.();
          } catch {
            /* already released */
          }
        }
      })();

      const out = new StreamCtor([generator, ...(stream.getAudioTracks?.() ?? [])]);
      return out;
    },

    /** Stop the loops and close every held frame. Safe to call twice. */
    release() {
      running = false;
      queue?.clear();
      queue = null;
    },

    stats() {
      return queue?.stats() ?? { held: 0, dropped: 0 };
    },
  };
}
