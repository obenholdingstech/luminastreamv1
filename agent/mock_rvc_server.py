"""Mock RVC WebSocket server — full plumbing test on a Mac, no GPU needed.

Speaks the exact bridge protocol (JSON config text frame, then binary
[uint32 seq][uint32 reserved][float32 PCM] both ways) and echoes every window
back unchanged after a configurable delay. Windows are processed FIFO per
connection, like the real GPU queue — a slow window delays the ones behind it.

Realism knobs (all mirror behavior observed against the real server):
  --delay-ms      per-window conversion time (default 70)
  --spike-ms      occasional slow window (default 150, every --spike-every th)
  --ratio         output length ratio (default 1.008 → exercises SOLA the way
                  the real server does; audio is resampled, ~13 cents sharp)

Run:  ./.venv/bin/python mock_rvc_server.py          (ws://127.0.0.1:8000/ws/audio)
"""

import argparse
import asyncio
import json
import logging
import struct
from fractions import Fraction

import numpy as np
from scipy.signal import resample_poly

import websockets

log = logging.getLogger("mock-rvc")


class MockRvc:
    def __init__(self, delay_ms, spike_ms, spike_every, ratio):
        self.delay_s = delay_ms / 1000.0
        self.spike_s = spike_ms / 1000.0
        self.spike_every = spike_every
        # small integer ratio for resample_poly (1.008 → 126/125)
        frac = Fraction(ratio).limit_denominator(1000)
        self.up, self.down = frac.numerator, frac.denominator

    def convert(self, pcm):
        if self.up == self.down:
            return pcm
        return resample_poly(pcm, self.up, self.down).astype("<f4")

    async def handle(self, ws):
        peer = getattr(ws, "remote_address", "?")
        log.info("client connected: %s", peer)
        queue = asyncio.Queue()
        n_windows = 0

        async def worker():
            """FIFO conversion queue — mirrors the real server's GPU serialization."""
            nonlocal n_windows
            while True:
                seq, pcm = await queue.get()
                n_windows += 1
                delay = (
                    self.spike_s
                    if self.spike_every and n_windows % self.spike_every == 0
                    else self.delay_s
                )
                await asyncio.sleep(delay)
                out = self.convert(pcm)
                await ws.send(struct.pack("<II", seq, 0) + out.tobytes())

        worker_task = asyncio.create_task(worker())
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    try:
                        cfg = json.loads(msg)
                        log.info("config: %s", cfg)
                    except json.JSONDecodeError:
                        log.warning("non-JSON text frame: %s", msg[:120])
                    continue
                b = bytes(msg)
                if len(b) < 8 or (len(b) - 8) % 4 != 0:
                    log.warning("bad binary frame (%d bytes) — ignored", len(b))
                    continue
                seq, _ = struct.unpack("<II", b[:8])
                pcm = np.frombuffer(b[8:], dtype="<f4")
                await queue.put((seq, pcm))
        except websockets.ConnectionClosed:
            pass
        finally:
            worker_task.cancel()
            log.info("client gone: %s (%d windows served)", peer, n_windows)


async def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--delay-ms", type=float, default=70.0)
    ap.add_argument("--spike-ms", type=float, default=150.0)
    ap.add_argument("--spike-every", type=int, default=10,
                    help="every Nth window takes --spike-ms (0 disables)")
    ap.add_argument("--ratio", type=float, default=1.008,
                    help="output/input length ratio (1.0 = bit-exact echo)")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    mock = MockRvc(args.delay_ms, args.spike_ms, args.spike_every, args.ratio)
    # Path is not enforced — both /ws/audio (the real server's path) and / work
    async with websockets.serve(mock.handle, args.host, args.port, max_size=None):
        log.info(
            "mock RVC listening on ws://%s:%d/ws/audio (delay %.0fms, spike %.0fms/%d, ratio %.3f)",
            args.host, args.port, args.delay_ms, args.spike_ms, args.spike_every, args.ratio,
        )
        await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
