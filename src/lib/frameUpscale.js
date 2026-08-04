// The mechanism half of the upscale stage (ROADMAP §P3), shaped exactly like
// frameDelay: insertable streams in, insertable streams out, everything
// injected so the loop is testable in node with fake tracks and a fake
// renderer, and an HONEST PASSTHROUGH wherever the platform cannot deliver.
//
// One loop, inline transform: read a decoded frame, render it bigger and
// sharper, close the input, write the output. If the consumer stalls, the
// loop stalls and upstream drops frames — a skipped frame is the correct
// failure for live video; a queue here would only add latency the align
// stage just paid to control.
//
// Renderer failures are containment lines twice over: a renderer that
// cannot be BUILT means wrap() returns the original stream (the stage stays
// inactive and the readout keeps saying 720p); a renderer that breaks
// MID-STREAM ends the wrap quietly — the upstream track keeps flowing to
// nothing, and the visible symptom is the stage reporting inactive, never a
// dead lens.

/**
 * @param {{
 *   createRenderer: (args: { source: {width:number,height:number}, output: {width:number,height:number} }) => any,
 *   output: { width: number, height: number },
 *   source?: { width: number, height: number },
 *   Processor?: any,
 *   Generator?: any,
 *   StreamCtor?: any,
 * }} deps
 */
export function createFrameUpscale({
  createRenderer,
  output,
  source = { width: 1280, height: 720 },
  Processor = globalThis.MediaStreamTrackProcessor,
  Generator = globalThis.MediaStreamTrackGenerator,
  StreamCtor = globalThis.MediaStream,
}) {
  const supported =
    typeof Processor === 'function' &&
    typeof Generator === 'function' &&
    typeof createRenderer === 'function';
  let running = false;
  let renderer = null;

  return {
    get supported() {
      return supported;
    },
    output,

    /**
     * Wrap a stream: same audio tracks, video upscaled frame by frame.
     * Returns the ORIGINAL stream untouched wherever anything cannot be
     * built — the caller reads identity as "not upscaling" and stays honest.
     */
    wrap(stream) {
      if (!supported || !stream) return stream;
      const [videoTrack] = stream.getVideoTracks?.() ?? [];
      if (!videoTrack) return stream;

      try {
        renderer = createRenderer({ source, output });
      } catch {
        renderer = null;
        return stream; // no GPU, no WebGL2 — 720p remains the truth
      }

      const processor = new Processor({ track: videoTrack });
      const generator = new Generator({ kind: 'video' });
      running = true;

      (async () => {
        const reader = processor.readable.getReader();
        const writer = generator.writable.getWriter();
        try {
          while (running) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!running) {
              value.close?.();
              break;
            }
            let out = null;
            try {
              out = renderer.render(value);
            } catch {
              value.close?.();
              break; // mid-stream GPU loss: stop transforming, stop claiming
            }
            value.close?.();
            await writer.write(out);
          }
        } catch {
          /* track ended or generator closed */
        } finally {
          reader.releaseLock?.();
          try {
            writer.releaseLock?.();
          } catch {
            /* already released */
          }
          renderer?.dispose?.();
          renderer = null;
        }
      })();

      return new StreamCtor([generator, ...(stream.getAudioTracks?.() ?? [])]);
    },

    /** Stop the loop and lose the GL context. Safe to call twice. */
    release() {
      running = false;
      renderer?.dispose?.();
      renderer = null;
    },
  };
}
