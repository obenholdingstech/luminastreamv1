"""Session capture for the convert agent — diagnostic recording (Phase 1).

One SessionCapture per processing session (one adopted track). It writes a
timestamped subdirectory under the given capture dir containing:

  input_48k.wav   mono 48k int16 — frames exactly as received from LiveKit
                  (post-AudioStream), regardless of mode
  output_48k.wav  mono 48k int16 — frames as published back (passthrough:
                  the passthrough audio; convert: the stitched converted audio)
  meta.jsonl      one JSON object per line: session header, per-window
                  timing, drops, underruns, stale discards, mode changes,
                  jitter-buffer depth per hop

Hot-path contract: add_input/add_output/event/window_* are pure in-memory
appends — ZERO disk I/O. All file work (mkdir included) happens in a
background task through aiofiles, flushing every FLUSH_INTERVAL_S. The WAVs
are written with a placeholder header that is patched with the real sizes on
aclose(), so an aborted session leaves a header claiming 0 data bytes rather
than a corrupt file.

Self-defense: capture can never hurt the audio path. If the background
writer fails, falls more than MAX_BUFFERED_SECONDS behind, or the session
exceeds MAX_CAPTURE_SECONDS, capture disables itself for the session — one
loud log line, buffers freed, every hot-path call a no-op from then on. The
duration cap also keeps the data far below the 4 GiB the WAV uint32 header
fields can represent.

Every event line carries:
  t        seconds since session start (monotonic clock)
  in_pos   input samples captured so far  → position on the input timeline
  out_pos  output samples captured so far → position on the output timeline
which is what lets analyze_capture.py pin events onto the waveforms.
"""

import asyncio
import json
import logging
import struct
import time
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
import aiofiles.os

log = logging.getLogger("capture")

FLUSH_INTERVAL_S = 0.5
SAMPLE_RATE = 48000
SAMPLE_WIDTH = 2  # int16
WAV_HEADER_BYTES = 44

# Bounds — hitting any of them disables capture for the session (agent unaffected)
MAX_BUFFERED_SECONDS = 60          # pending un-flushed audio (writer fell behind)
MAX_BUFFERED_BYTES = MAX_BUFFERED_SECONDS * SAMPLE_RATE * SAMPLE_WIDTH * 2  # in+out
MAX_CAPTURE_SECONDS = 3600         # per-stream session cap; 1 h ≈ 330 MiB/WAV,
                                   # far below the uint32 RIFF/data limit (4 GiB)
MAX_EVENTS_PENDING = 200_000       # un-flushed meta lines


def wav_header(n_data_bytes, sample_rate=SAMPLE_RATE, channels=1, sampwidth=SAMPLE_WIDTH):
    """Standard 44-byte PCM WAV header for n_data_bytes of payload."""
    byte_rate = sample_rate * channels * sampwidth
    block_align = channels * sampwidth
    return (
        b"RIFF"
        + struct.pack("<I", 36 + n_data_bytes)
        + b"WAVEfmt "
        + struct.pack(
            "<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, sampwidth * 8
        )
        + b"data"
        + struct.pack("<I", n_data_bytes)
    )


class SessionCapture:
    """Buffers audio + events in memory; a background task owns all disk I/O."""

    def __init__(self, capture_dir, header):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        self.session_dir = Path(capture_dir) / stamp
        self._t0 = time.monotonic()
        self._in_bufs = []       # list[bytes] pending flush
        self._out_bufs = []
        self._events = []        # list[str] pending JSON lines
        self.in_samples = 0      # totals across the whole session
        self.out_samples = 0
        self._pending = {}       # seq → t_sent (windows in flight to RVC)
        self._pending_bytes = 0  # audio bytes appended but not yet flushed
        self._dead = False       # tripped a bound / writer failed — all no-ops
        self._closing = False
        self._stop = asyncio.Event()
        self._task = None
        # per-instance so tests can tighten them
        self.max_buffered_bytes = MAX_BUFFERED_BYTES
        self.max_capture_samples = MAX_CAPTURE_SECONDS * SAMPLE_RATE
        self._emit("session", **dict(header, wall_time=datetime.now(timezone.utc).isoformat()))

    def start(self):
        self._task = asyncio.ensure_future(self._run())
        return self

    # ── hot path: memory appends only ────────────────────────────────

    def add_input(self, data):
        """data: int16 mono 48k bytes as received from the AudioStream."""
        if self._dead:
            return
        b = bytes(data)
        self._in_bufs.append(b)
        self._pending_bytes += len(b)
        self.in_samples += len(b) // SAMPLE_WIDTH
        self._check_bounds()

    def add_output(self, data):
        """data: int16 mono 48k bytes as handed to capture_frame."""
        if self._dead:
            return
        b = bytes(data)
        self._out_bufs.append(b)
        self._pending_bytes += len(b)
        self.out_samples += len(b) // SAMPLE_WIDTH
        self._check_bounds()

    def event(self, kind, **fields):
        self._emit(kind, **fields)

    def window_sent(self, seq):
        if self._dead:
            return
        self._pending[seq] = time.monotonic() - self._t0

    def window_send_failed(self, seq):
        t_sent = self._pending.pop(seq, None)
        self._emit("send_failed", seq=seq,
                   t_sent=None if t_sent is None else round(t_sent, 4))

    def window_recv(self, seq):
        """Emits the combined per-window line {seq, t_sent, t_recv, turnaround_ms}."""
        t_recv = time.monotonic() - self._t0
        t_sent = self._pending.pop(seq, None)
        turnaround = None if t_sent is None else round((t_recv - t_sent) * 1000.0, 1)
        self._emit("window", seq=seq,
                   t_sent=None if t_sent is None else round(t_sent, 4),
                   t_recv=round(t_recv, 4), turnaround_ms=turnaround)

    def window_stale(self, seq, reason=None):
        """A converted window came back but was discarded as stale.

        Pops the pending entry so the window is counted exactly once — as
        stale, never additionally as window_lost at close.
        """
        t_recv = time.monotonic() - self._t0
        t_sent = self._pending.pop(seq, None)
        fields = {"seq": seq, "t_recv": round(t_recv, 4)}
        if t_sent is not None:
            fields["t_sent"] = round(t_sent, 4)
            fields["turnaround_ms"] = round((t_recv - t_sent) * 1000.0, 1)
        if reason:
            fields["reason"] = reason
        self._emit("stale", **fields)

    def _emit(self, kind, **fields):
        if self._dead:
            return
        line = {
            "event": kind,
            "t": round(time.monotonic() - self._t0, 4),
            "in_pos": self.in_samples,
            "out_pos": self.out_samples,
        }
        line.update(fields)
        self._events.append(json.dumps(line))
        if len(self._events) > MAX_EVENTS_PENDING:
            self._disable("meta event buffer exceeded %d pending lines" % MAX_EVENTS_PENDING)

    def _check_bounds(self):
        if self._pending_bytes > self.max_buffered_bytes:
            self._disable(
                "writer fell behind — >%ds of audio (%d bytes) buffered un-flushed"
                % (MAX_BUFFERED_SECONDS, self._pending_bytes)
            )
        elif (self.in_samples > self.max_capture_samples
              or self.out_samples > self.max_capture_samples):
            self._disable(
                "session exceeded max capture duration (%ds) — WAVs finalized "
                "with the audio captured so far" % (self.max_capture_samples // SAMPLE_RATE)
            )

    def _disable(self, reason, exc_info=False):
        """Kill capture for this session; the agent's audio path is untouched."""
        if self._dead:
            return
        self._dead = True  # before anything else — every hot-path call is a no-op now
        self._in_bufs.clear()
        self._out_bufs.clear()
        self._events.clear()
        self._pending.clear()
        self._pending_bytes = 0
        # One trace line for the meta file, if the writer is still alive to flush it
        self._events.append(json.dumps({
            "event": "capture_disabled",
            "t": round(time.monotonic() - self._t0, 4),
            "in_pos": self.in_samples,
            "out_pos": self.out_samples,
            "reason": reason,
        }))
        log.error("capture DISABLED for %s: %s — agent audio unaffected",
                  self.session_dir, reason, exc_info=exc_info)

    # ── background flush task: owns ALL disk I/O ─────────────────────

    async def _run(self):
        try:
            await aiofiles.os.makedirs(self.session_dir, exist_ok=True)
            async with aiofiles.open(self.session_dir / "input_48k.wav", "wb") as f_in, \
                    aiofiles.open(self.session_dir / "output_48k.wav", "wb") as f_out, \
                    aiofiles.open(self.session_dir / "meta.jsonl", "w") as f_meta:
                await f_in.write(wav_header(0))
                await f_out.write(wav_header(0))
                in_bytes = out_bytes = 0
                while True:
                    stopped = self._stop.is_set()
                    in_bytes += await self._drain(self._in_bufs, f_in)
                    out_bytes += await self._drain(self._out_bufs, f_out)
                    if self._events:
                        lines, self._events = self._events, []
                        await f_meta.write("\n".join(lines) + "\n")
                    if stopped:
                        break
                    try:
                        await asyncio.wait_for(self._stop.wait(), FLUSH_INTERVAL_S)
                    except asyncio.TimeoutError:
                        pass
                await f_in.seek(0)
                await f_in.write(wav_header(in_bytes))
                await f_out.seek(0)
                await f_out.write(wav_header(out_bytes))
            log.info(
                "capture closed: %s (%.1fs in, %.1fs out)",
                self.session_dir,
                in_bytes / (SAMPLE_RATE * SAMPLE_WIDTH),
                out_bytes / (SAMPLE_RATE * SAMPLE_WIDTH),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._disable("background writer failed: %r" % (exc,), exc_info=True)

    async def _drain(self, bufs, f):
        if not bufs:
            return 0
        chunks, bufs[:] = list(bufs), []
        data = b"".join(chunks)
        await f.write(data)
        self._pending_bytes = max(0, self._pending_bytes - len(data))
        return len(data)

    async def aclose(self):
        if self._closing:
            return
        self._closing = True
        # Windows still in flight never came back — record them before the final drain
        for seq, t_sent in sorted(self._pending.items()):
            self._emit("window_lost", seq=seq, t_sent=round(t_sent, 4))
        self._pending.clear()
        self._emit("session_end")
        self._stop.set()
        if self._task is not None:
            await self._task
