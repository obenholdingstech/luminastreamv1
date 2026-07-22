"""Async client for the RVC streaming WebSocket (stateless sliding-window protocol).

Wire protocol (proven in bridge_test_v3.py):
  1. JSON config text frame first
  2. then binary frames both directions: [uint32 seq][uint32 reserved][float32 PCM]

connect() always performs the warmup exchange (seq-0 window of zeros, wait for
the first binary reply) — so a reconnect after a drop re-warms the model by
construction, and the caller can warm up BEFORE any live audio flows.

The server must run with RVC_STREAM_CONTEXT_SECONDS=0 (stateless windows).
"""

import asyncio
import json
import logging
import struct
import time
from collections import deque

import numpy as np

import websockets

log = logging.getLogger("rvc-client")

DEFAULT_CONFIG = {
    "sample_rate": 48000,
    "chunk_size": 14336,  # CTX 8192 + HOP 6144
    "f0_method": "rmvpe",
    "index_rate": 0.75,
    "protect": 0.33,
    "rms_mix_rate": 0.25,
    "filter_radius": 3,
    "pitch_shift": 0,
}


class RvcClient:
    """One WS connection to the RVC server, with in-flight and latency tracking.

    on_window(seq, pcm) is invoked from the receive loop for every converted
    window; on_disconnect(exc) fires once when the connection drops for any
    reason other than an explicit close(). Reconnect policy lives with the
    caller: just call connect() again — it re-warms every time.
    """

    def __init__(self, url, config=None, *, warmup_timeout=90.0,
                 on_window=None, on_disconnect=None):
        self.url = url
        self.config = dict(DEFAULT_CONFIG, **(config or {}))
        self.warmup_timeout = warmup_timeout
        self.on_window = on_window
        self.on_disconnect = on_disconnect
        self.connected = False
        self.warmup_s = None
        self.windows_sent = 0
        self.windows_received = 0
        self._ws = None
        self._recv_task = None
        self._closing = False
        self._sent_at = {}  # seq → perf_counter at send
        self._latencies_ms = deque(maxlen=256)

    # ── lifecycle ────────────────────────────────────────────────────

    async def connect(self):
        """Connect + config + warmup. Raises on any failure (caller retries)."""
        await self.close()
        self._closing = False
        ws = await websockets.connect(self.url, max_size=None)
        try:
            await ws.send(json.dumps(self.config))
            warm = np.zeros(self.config["chunk_size"], dtype="<f4")
            await ws.send(struct.pack("<II", 0, 0) + warm.tobytes())
            t0 = time.perf_counter()
            while True:
                remaining = self.warmup_timeout - (time.perf_counter() - t0)
                if remaining <= 0:
                    raise TimeoutError("RVC warmup timed out")
                msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
                if isinstance(msg, (bytes, bytearray)):
                    break  # warmup window came back — model is hot
                log.info("server text during warmup: %s", str(msg)[:160])
        except BaseException:
            await ws.close()
            raise
        self._ws = ws
        self.warmup_s = time.perf_counter() - t0
        self.connected = True
        self._sent_at.clear()
        self._recv_task = asyncio.create_task(self._recv_loop(ws))
        log.info("connected to %s (warmup %.1fs)", self.url, self.warmup_s)

    async def close(self):
        self._closing = True
        self.connected = False
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):
                pass
            self._recv_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        self._sent_at.clear()

    # ── traffic ──────────────────────────────────────────────────────

    @property
    def in_flight(self):
        return len(self._sent_at)

    async def send_window(self, seq, pcm):
        if not self.connected or self._ws is None:
            raise ConnectionError("RVC client is not connected")
        self._sent_at[seq] = time.perf_counter()
        try:
            payload = struct.pack("<II", seq, 0) + np.asarray(pcm, dtype="<f4").tobytes()
            await self._ws.send(payload)
        except BaseException:
            self._sent_at.pop(seq, None)
            raise
        self.windows_sent += 1

    async def _recv_loop(self, ws):
        exc = None
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    log.info("server text: %s", msg[:160])
                    continue
                b = bytes(msg)
                if len(b) >= 8 and (len(b) - 8) % 4 == 0:
                    seq, _ = struct.unpack("<II", b[:8])
                    pcm = np.frombuffer(b[8:], dtype="<f4").astype(np.float32)
                else:
                    log.warning("unparseable binary frame (%d bytes) — skipped", len(b))
                    continue
                sent = self._sent_at.pop(seq, None)
                if sent is not None:
                    self._latencies_ms.append((time.perf_counter() - sent) * 1000.0)
                self.windows_received += 1
                if self.on_window is not None:
                    self.on_window(seq, pcm)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            exc = e
        finally:
            was_connected = self.connected
            self.connected = False
            self._sent_at.clear()
            if not self._closing and was_connected:
                log.warning("RVC connection dropped: %s", exc)
                if self.on_disconnect is not None:
                    self.on_disconnect(exc)

    # ── stats ────────────────────────────────────────────────────────

    def turnaround_ms(self):
        """(p50, p95) over the most recent windows, or (None, None)."""
        if not self._latencies_ms:
            return None, None
        lat = sorted(self._latencies_ms)
        return lat[len(lat) // 2], lat[min(len(lat) - 1, int(len(lat) * 0.95))]
