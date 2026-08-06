// The mechanism half of the synthesis stage: insertable streams in,
// insertable streams out, shaped like frameUpscale but with one structural
// difference — synthesis needs the NEXT frame before it can invent the
// middle, so output leaves this loop up to one native interval late. That
// lookahead is the entire latency price of smoothness; the trim knob and
// the elastic absorb it like any other video-path cost.
//
// OUTPUT IS A TARGET RATE, NOT A MULTIPLE (CEO verdict, 6 Aug 2026: 30fps —
// 57 was overshoot). The loop lays a fixed 1000/targetFps grid over time and
// emits one frame per grid tick: synthesized at fractional t between the
// bracketing real pair, or the REAL frame itself when a tick lands within
// SNAP of it (no point inventing what the vendor just delivered). Native
// ~19fps has no integer factor that lands on 30, and a grid also keeps the
// output rate steady if the vendor's own rate drifts.
//
// The mode is LIVE-SWITCHABLE: the loop reads { targetFps, renderer } from a
// controller each iteration, so the governor can demote motion → blend →
// off mid-session without tearing the stream down. 'off' (targetFps null) is
// a pure forward — write on arrival, no grid, no renderer — which is why
// demotion always lands somewhere safe.
//
// Frame lifecycle rules (each learned the hard way in frameUpscale):
// a written frame is TRANSFERRED, so the pair-state keeps a clone(); every
// input is closed exactly once — including a real frame the grid decided
// NOT to emit; a rejected write closes the whole owned remainder; a
// renderer failure forwards the real frame and reports — the stream never
// dies for a shader.

/**
 * @param {{
 *   controller: { current: { targetFps: number|null, renderer: any } },
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
  // A grid tick this close to a real frame emits the real frame instead of
  // synthesizing a near-copy of it.
  const SNAP_US = 8_000;

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
        /** @type {number|null} the next output grid time, µs */
        let nextTickUs = null;
        try {
          while (running) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            if (!running) {
              frame.close?.();
              break;
            }

            const { targetFps, renderer } = controller.current;

            // 'off' — pure forward. Also drop pair-state AND the grid
            // cursor, so a later upgrade never interpolates or paces across
            // the span it was off for.
            if (targetFps == null || targetFps <= 0 || !renderer) {
              prev?.close?.();
              prev = null;
              nextTickUs = null;
              await writeOrClose(writer, frame);
              continue;
            }

            const tickUs = 1_000_000 / targetFps;

            if (!prev) {
              // The chain opens on a real frame; the grid starts one tick
              // after it.
              prev = frame.clone();
              nextTickUs = frame.timestamp + tickUs;
              await writeOrClose(writer, frame);
              continue;
            }

            const intervalUs = frame.timestamp - prev.timestamp;
            if (
              !Number.isFinite(intervalUs) ||
              intervalUs < MIN_INTERVAL_US ||
              intervalUs > MAX_INTERVAL_US
            ) {
              // Discontinuity: restart the pair and the grid, forward the
              // real frame.
              prev.close?.();
              prev = frame.clone();
              nextTickUs = frame.timestamp + tickUs;
              await writeOrClose(writer, frame);
              continue;
            }

            // Consume every grid tick this pair covers, rendering UP FRONT
            // (both inputs are certainly alive here), then pace the writes.
            const outs = [];
            let usedRealFrame = false;
            let failed = false;
            while (nextTickUs != null && nextTickUs <= frame.timestamp + SNAP_US) {
              if (!usedRealFrame && Math.abs(nextTickUs - frame.timestamp) <= SNAP_US) {
                // The vendor just delivered this moment — emit it as-is.
                outs.push(frame);
                usedRealFrame = true;
              } else {
                const t = (nextTickUs - prev.timestamp) / intervalUs;
                const t0 = now();
                try {
                  outs.push(renderer.synthesize(prev, frame, t, Math.round(nextTickUs)));
                } catch (err) {
                  failed = true;
                  onRenderError(err);
                  break;
                }
                onSample(now() - t0);
              }
              nextTickUs += tickUs;
            }

            if (failed) {
              for (const o of outs) {
                if (o !== frame) o?.close?.();
              }
              prev.close?.();
              prev = frame.clone();
              nextTickUs = frame.timestamp + tickUs;
              await writeOrClose(writer, frame);
              continue;
            }

            prev.close?.();
            prev = frame.clone();
            // A real frame the grid decided not to emit is still OURS to
            // close — the resampler drops it, nobody else ever sees it.
            if (!usedRealFrame) frame.close?.();

            if (outs.length === 0) continue; // native outran the grid this pair

            // The paced write sequence owns every frame in it until each
            // write lands. writeOrClose closes the one it was writing when a
            // write rejects — the remainder is closed before the failure
            // propagates. Gaps sum to one native interval, whatever the
            // output count, so pacing never drifts against arrival.
            const slotMs = intervalUs / 1000 / outs.length;
            const pending = [...outs];
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
