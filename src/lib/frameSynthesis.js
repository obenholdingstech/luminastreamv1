// The mechanism half of the synthesis stage: insertable streams in,
// insertable streams out, shaped like frameUpscale but with one structural
// difference — synthesis needs the NEXT frame before it can invent the
// middle, so real frames leave this loop one pacing-slot late and the
// invented frames fill the gap. That lookahead ((factor-1)/factor of a frame
// interval, ~35ms at 19fps ×3) is the entire latency price of smoothness;
// the trim knob and the elastic absorb it like any other video-path cost.
//
// The mode is LIVE-SWITCHABLE: the loop reads { factor, renderer } from a
// controller each iteration, so the governor can demote motion → blend →
// off mid-session without tearing the stream down. 'off' (factor 1) is a
// pure forward — write on arrival, no timers, no renderer — which is why
// demotion always lands somewhere safe.
//
// Frame lifecycle rules (each learned the hard way in frameUpscale):
// a written frame is TRANSFERRED, so the pair-state keeps a clone(); every
// input is closed exactly once; a rejected write closes the frame it owned;
// a renderer failure forwards the real frame and reports — the stream never
// dies for a shader.

/**
 * @param {{
 *   controller: { current: { factor: number, renderer: any } },
 *   onSample?: (renderMs: number) => void,
 *   onRenderError?: (err: unknown) => void,
 *   Processor?: any,
 *   Generator?: any,
 *   StreamCtor?: any,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createFrameSynthesis({
  controller,
  onSample = () => {},
  onRenderError = () => {},
  Processor = globalThis.MediaStreamTrackProcessor,
  Generator = globalThis.MediaStreamTrackGenerator,
  StreamCtor = globalThis.MediaStream,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
}) {
  const supported = typeof Processor === 'function' && typeof Generator === 'function';
  let running = false;

  // A frame gap outside this window is a discontinuity (stall, seek, clock
  // jump) — interpolating across it would smear two unrelated moments.
  const MIN_INTERVAL_US = 10_000;
  const MAX_INTERVAL_US = 250_000;

  return {
    get supported() {
      return supported;
    },

    /** Wrap a stream; returns the ORIGINAL untouched when unsupported. */
    wrap(stream) {
      if (!supported || !stream) return stream;
      const [videoTrack] = stream.getVideoTracks?.() ?? [];
      if (!videoTrack) return stream;

      const processor = new Processor({ track: videoTrack });
      const generator = new Generator({ kind: 'video' });
      running = true;

      (async () => {
        const reader = processor.readable.getReader();
        const writer = generator.writable.getWriter();
        /** @type {any} */
        let prev = null;
        try {
          while (running) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            if (!running) {
              frame.close?.();
              break;
            }

            const { factor, renderer } = controller.current;

            // 'off' — pure forward. Also drop pair-state so a later upgrade
            // never interpolates across the gap it was off for.
            if (factor <= 1 || !renderer) {
              prev?.close?.();
              prev = null;
              await writeOrClose(writer, frame);
              continue;
            }

            if (!prev) {
              prev = frame.clone();
              await writeOrClose(writer, frame);
              continue;
            }

            const intervalUs = frame.timestamp - prev.timestamp;
            if (
              !Number.isFinite(intervalUs) ||
              intervalUs < MIN_INTERVAL_US ||
              intervalUs > MAX_INTERVAL_US
            ) {
              // Discontinuity: restart the pair, forward the real frame.
              prev.close?.();
              prev = frame.clone();
              await writeOrClose(writer, frame);
              continue;
            }

            // Render every intermediate UP FRONT (both inputs are certainly
            // alive here), then pace the writes so presentation is uniform.
            const mids = [];
            let failed = false;
            for (let i = 1; i < factor; i++) {
              const t0 = now();
              try {
                const ts = Math.round(prev.timestamp + (intervalUs * i) / factor);
                mids.push(renderer.synthesize(prev, frame, i / factor, ts));
              } catch (err) {
                failed = true;
                onRenderError(err);
                break;
              }
              onSample(now() - t0);
            }
            if (failed) {
              for (const m of mids) m?.close?.();
              prev.close?.();
              prev = frame.clone();
              await writeOrClose(writer, frame);
              continue;
            }

            prev.close?.();
            prev = frame.clone();
            const slotMs = intervalUs / 1000 / factor;
            // The paced write sequence owns every frame in it until each
            // write lands. writeOrClose closes the one it was writing when a
            // write rejects, but the REST of the queue would leak with it —
            // so the remainder is closed before the failure propagates.
            const pending = [...mids, frame];
            try {
              while (pending.length > 0) {
                await writeOrClose(writer, pending[0]);
                pending.shift();
                if (pending.length > 0) await sleep(slotMs);
              }
            } catch (err) {
              for (const rest of pending.slice(1)) rest?.close?.();
              throw err;
            }
          }
        } catch {
          /* track ended or generator closed */
        } finally {
          prev?.close?.();
          prev = null;
          reader.releaseLock?.();
          try {
            writer.releaseLock?.();
          } catch {
            /* already released */
          }
        }
      })();

      return new StreamCtor([generator, ...(stream.getAudioTracks?.() ?? [])]);
    },

    release() {
      running = false;
    },
  };
}

/** Write a frame we own; a rejected write still closes it (GPU memory). */
async function writeOrClose(writer, frame) {
  try {
    await writer.write(frame);
  } catch (err) {
    frame.close?.();
    throw err;
  }
}
