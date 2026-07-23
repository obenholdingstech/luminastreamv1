"""LuminaStream convert agent — Move 2b: the RVC conversion worker.

Same transport skeleton as echo_agent.py (kept untouched as the known-good
reference), with a LIVE mode toggle:

  passthrough  frames copied straight through; RVC sits idle (GPU cost control)
  convert      frames → WindowAssembler → RVC websocket → SolaStitcher → frames

Data-channel protocol (JSON, reliable):
  browser → agent   {"type":"set_mode","mode":"passthrough"|"convert"}
  agent → browser   {"type":"agent_mode","mode":...,"reason"?:...}
The agent is the source of truth: the browser UI shows what the agent
confirmed, not what the button asked for. Confirmation is re-sent whenever a
participant joins.

Robustness: RVC is warmed up BEFORE joining the room (the stream never sees a
cold model). If the RVC connection is missing/drops while converting, the agent
falls back to passthrough (reason "rvc_unavailable"), retries in the
background, and restores convert mode automatically once RVC recovers.

Diagnostics: --capture-dir PATH records each processing session (input/output
WAVs + meta.jsonl event log) for offline analysis with analyze_capture.py.
The hot path only ever does in-memory appends (see capture.py); without the
flag every hook is a single `if self.capture` on a None.

Run:  python convert_agent.py [--mode passthrough|convert] [--capture-dir PATH]
      RVC_WS_URL=ws://127.0.0.1:8000/ws/audio (default; see README.md)
The RVC server must run with RVC_STREAM_CONTEXT_SECONDS=0 (stateless windows).
"""

import argparse
import asyncio
import json
import logging
import os
from datetime import timedelta
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc

from bridge import CTX, HOP, SOLA, XFADE, SolaStitcher, WindowAssembler
from capture import SessionCapture
from rvc_client import RvcClient

DEFAULT_ROOM = "luminastream-test"
DEFAULT_IDENTITY = "echo-convert-agent"  # echo-* prefix: agents ignore each other
DEFAULT_RVC_WS_URL = "ws://127.0.0.1:8000/ws/audio"

SAMPLE_RATE = 48000
NUM_CHANNELS = 1

MODES = ("passthrough", "convert")
MAX_IN_FLIGHT = 2      # beyond this, drop the hop — late audio is worse than lost audio
PRIME_SAMPLES = int(1.5 * HOP)  # jitter buffer: drain only after ~1.5 hops buffered
RVC_RETRY_S = 5.0
STATS_INTERVAL_S = 5

log = logging.getLogger("convert-agent")


def load_credentials():
    """Read LIVEKIT_* from the repo-root secrets.env — never hardcoded."""
    repo_root = Path(__file__).resolve().parent.parent
    load_dotenv(repo_root / "secrets.env")
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not url or not key or not secret:
        raise SystemExit(
            "secrets.env must define LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET"
        )
    return url, key, secret


def mint_token(key, secret, room, identity):
    return (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name("Convert Agent")
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .with_ttl(timedelta(hours=2))
        .to_jwt()
    )


class ConvertAgent:
    def __init__(self, room_name, identity, rvc_url, requested_mode, capture_dir=None):
        self.room_name = room_name
        self.identity = identity
        self.rvc_url = rvc_url
        self.capture_dir = capture_dir  # None ⇒ capture fully disabled
        self.capture = None             # SessionCapture while a session runs
        self.room = rtc.Room()
        self.source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)

        self.mode = "passthrough"          # actual mode (source of truth)
        self.requested_mode = requested_mode  # what the user asked for last
        self.mode_reason = None

        self.assembler = WindowAssembler()
        self.stitcher = SolaStitcher()
        self.rvc = RvcClient(
            rvc_url,
            on_window=self._on_converted,
            on_disconnect=self._on_rvc_drop,
        )
        self._primed = False
        self._min_valid_seq = 1   # converted windows below this are stale (pre-toggle)
        self._last_pushed_seq = 0
        self._rvc_retry_task = None
        self._closing = False

        self.process_task = None
        self.processed_identity = None
        self.frames_in = 0
        self.frames_out = 0
        self.windows_dropped = 0   # backpressure drops (in-flight >= MAX_IN_FLIGHT)
        self.windows_stale = 0     # returns discarded after a mode reset
        self._register_handlers()

    # ── Room events ──────────────────────────────────────────────────

    def _register_handlers(self):
        room = self.room

        @room.on("connection_state_changed")
        def _on_state(state):
            try:
                name = rtc.ConnectionState.Name(state)
            except ValueError:
                name = str(state)
            log.info("connection state: %s", name)

        @room.on("disconnected")
        def _on_disconnected(reason):
            log.warning("disconnected from room: %s", reason)

        @room.on("participant_connected")
        def _on_participant(p):
            log.info("participant connected: %s", p.identity)
            # Late joiners need to know the current mode immediately
            asyncio.ensure_future(self._publish_mode())

        @room.on("participant_disconnected")
        def _on_participant_gone(p):
            log.info("participant disconnected: %s", p.identity)

        @room.on("track_subscription_failed")
        def _on_sub_failed(participant, track_sid, error):
            log.error("track subscription failed for %s (%s): %s",
                      participant.identity, track_sid, error)

        @room.on("track_subscribed")
        def _on_track(track, publication, participant):
            self._maybe_adopt(track, participant)

        @room.on("track_unsubscribed")
        def _on_track_gone(track, publication, participant):
            if participant.identity == self.processed_identity and self.process_task:
                log.info("track from %s went away — stopping", participant.identity)
                self.process_task.cancel()

        @room.on("data_received")
        def _on_data(packet):
            self._handle_data(packet)

    def _maybe_adopt(self, track, participant):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if participant.identity.startswith("echo-"):
            log.info("ignoring audio from fellow agent %s", participant.identity)
            return
        if self.process_task and not self.process_task.done():
            log.warning("already processing %s — ignoring %s",
                        self.processed_identity, participant.identity)
            return
        self.processed_identity = participant.identity
        self.process_task = asyncio.ensure_future(self._process(track, participant.identity))

    # ── Mode control (data channel) ──────────────────────────────────

    def _handle_data(self, packet):
        who = packet.participant.identity if packet.participant else "server"
        try:
            msg = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return  # not ours
        if not isinstance(msg, dict) or msg.get("type") != "set_mode":
            return
        mode = msg.get("mode")
        if mode not in MODES:
            log.warning("ignoring set_mode with invalid mode %r from %s", mode, who)
            return
        log.info("set_mode(%s) from %s", mode, who)
        self.requested_mode = mode
        asyncio.ensure_future(self._apply_mode(mode))

    async def _apply_mode(self, mode, reason=None):
        if mode == "convert" and not self.rvc.connected:
            # Can't convert right now — stay/fall back to passthrough, keep
            # requested_mode=convert so recovery flips us automatically
            log.warning("convert requested but RVC unavailable — staying in passthrough")
            self._set_mode("passthrough", "rvc_unavailable")
            self._ensure_rvc_retry()
            await self._publish_mode()
            return
        self._set_mode(mode, reason)
        await self._publish_mode()

    def _set_mode(self, mode, reason=None):
        if mode == self.mode:
            self.mode_reason = reason
            return
        if mode == "convert":
            # Fresh pipeline state; seq keeps counting so stale in-flight
            # returns from the previous convert period are discarded by seq
            self.assembler.reset()
            self.stitcher.reset()
            self._primed = False
            self._min_valid_seq = self.assembler.seq + 1
        else:
            # Anything still in flight is now stale
            self._min_valid_seq = self.assembler.seq + 1
        self.mode = mode
        self.mode_reason = reason
        if self.capture:
            self.capture.event("mode_change", mode=mode, reason=reason)
        log.info("mode → %s%s", mode, f" ({reason})" if reason else "")

    async def _publish_mode(self):
        if self.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            return
        payload = {"type": "agent_mode", "mode": self.mode}
        if self.mode_reason:
            payload["reason"] = self.mode_reason
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload), reliable=True
            )
        except Exception as exc:
            log.error("failed to publish agent_mode: %s", exc)

    # ── RVC plumbing ─────────────────────────────────────────────────

    def _on_converted(self, seq, pcm):
        """Called from the RVC receive loop for every converted window."""
        if seq < self._min_valid_seq or seq <= self._last_pushed_seq:
            self.windows_stale += 1
            if self.capture:
                self.capture.window_stale(seq)
            return
        if self.mode != "convert":
            self.windows_stale += 1
            if self.capture:
                self.capture.window_stale(seq, reason="mode")
            return
        if self.capture:
            self.capture.window_recv(seq)
        self._last_pushed_seq = seq
        self.stitcher.push(pcm)

    def _on_rvc_drop(self, exc):
        if self._closing:
            return
        log.warning("RVC dropped (%s)", exc)
        if self.mode == "convert":
            asyncio.ensure_future(self._apply_mode_sync_fallback())
        self._ensure_rvc_retry()

    async def _apply_mode_sync_fallback(self):
        self._set_mode("passthrough", "rvc_unavailable")
        await self._publish_mode()

    def _ensure_rvc_retry(self):
        if self._rvc_retry_task is None or self._rvc_retry_task.done():
            self._rvc_retry_task = asyncio.ensure_future(self._rvc_retry_loop())

    async def _rvc_retry_loop(self):
        while not self._closing and not self.rvc.connected:
            await asyncio.sleep(RVC_RETRY_S)
            try:
                await self.rvc.connect()
            except Exception as exc:
                log.info("RVC retry failed: %s — next attempt in %.0fs", exc, RVC_RETRY_S)
        if self._closing or not self.rvc.connected:
            return
        log.info("RVC recovered")
        if self.requested_mode == "convert" and self.mode == "passthrough":
            await self._apply_mode("convert", "rvc_recovered")

    # ── The frame loop ───────────────────────────────────────────────

    async def _process(self, track, identity):
        log.info("processing %s → %s (%s mode)", identity, self.identity, self.mode)
        stream = rtc.AudioStream.from_track(
            track=track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS
        )
        if self.capture_dir:
            self.capture = SessionCapture(self.capture_dir, {
                "participant": identity,
                "mode": self.mode,
                "rvc_ws_url": self.rvc_url,
                "sample_rate": SAMPLE_RATE,
                "hop": HOP, "ctx": CTX, "xfade": XFADE, "sola": SOLA,
                "prime_samples": PRIME_SAMPLES,
            }).start()
            log.info("capture ON → %s", self.capture.session_dir)
        try:
            async for event in stream:
                self.frames_in += 1
                frame = event.frame
                if self.capture:
                    self.capture.add_input(bytes(frame.data))
                if self.mode == "convert":
                    await self._convert_frame(frame)
                else:
                    # Passthrough — the await IS the flow control
                    if self.capture:
                        self.capture.add_output(bytes(frame.data))
                    await self.source.capture_frame(frame)
                self.frames_out += 1
        except asyncio.CancelledError:
            pass
        finally:
            await stream.aclose()
            if self.capture:
                capture, self.capture = self.capture, None
                await capture.aclose()
            log.info("processing ended for %s", identity)
            self.processed_identity = None

    async def _convert_frame(self, frame):
        n = frame.samples_per_channel
        pcm = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0

        # Input side: window assembly + send with backpressure
        for seq, window in self.assembler.feed(pcm):
            if self.capture:  # jitter-buffer depth, sampled every hop
                self.capture.event("buffer_depth", seq=seq,
                                   depth=self.stitcher.available,
                                   in_flight=self.rvc.in_flight)
            if not self.rvc.connected:
                break  # drop fires fallback; frames keep flowing meanwhile
            if self.rvc.in_flight >= MAX_IN_FLIGHT:
                self.windows_dropped += 1  # skip the hop; stitcher underrun covers it
                if self.capture:
                    self.capture.event("drop", seq=seq)
                continue
            if self.capture:
                self.capture.window_sent(seq)
            try:
                await self.rvc.send_window(seq, window)
            except Exception as exc:
                log.warning("send_window failed: %s", exc)
                if self.capture:
                    self.capture.window_send_failed(seq)

        # Output side: 1 frame in → 1 frame out keeps the pacing of the input.
        # Before the jitter buffer is primed we emit silence instead of racing
        # ahead of the converter.
        if not self._primed and self.stitcher.available >= PRIME_SAMPLES:
            self._primed = True
            log.info("jitter buffer primed (%d samples)", self.stitcher.available)
        if self._primed:
            underruns_before = self.stitcher.underrun_events
            samples = self.stitcher.read(n)
            if self.capture and self.stitcher.underrun_events > underruns_before:
                self.capture.event("underrun", samples=n)
        else:
            samples = np.zeros(n, dtype=np.float32)

        out = rtc.AudioFrame.create(SAMPLE_RATE, NUM_CHANNELS, n)
        np.frombuffer(out.data, dtype=np.int16)[:] = (
            np.clip(samples, -1.0, 1.0) * 32767.0
        ).astype(np.int16)
        if self.capture:
            self.capture.add_output(bytes(out.data))
        await self.source.capture_frame(out)

    # ── Stats ────────────────────────────────────────────────────────

    async def _stats_loop(self):
        prev = (0, 0)
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            cur = (self.frames_in, self.frames_out)
            p50, p95 = self.rvc.turnaround_ms()
            log.info(
                "stats: mode=%s frames in=%d (+%d) out=%d (+%d) | windows sent=%d recv=%d "
                "dropped=%d stale=%d | underruns=%d (%d samples) | turnaround p50/p95=%s/%s ms | "
                "buffer=%d samples (%.2f hops)",
                self.mode,
                cur[0], cur[0] - prev[0], cur[1], cur[1] - prev[1],
                self.rvc.windows_sent, self.rvc.windows_received,
                self.windows_dropped, self.windows_stale,
                self.stitcher.underrun_events, self.stitcher.underrun_samples,
                "-" if p50 is None else f"{p50:.0f}",
                "-" if p95 is None else f"{p95:.0f}",
                self.stitcher.available, self.stitcher.available / HOP,
            )
            prev = cur

    # ── Lifecycle ────────────────────────────────────────────────────

    async def start(self, url, token):
        await self.room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
        log.info("connected to room %s as %s", self.room_name, self.identity)

        local_track = rtc.LocalAudioTrack.create_audio_track("convert", self.source)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        publication = await self.room.local_participant.publish_track(local_track, options)
        log.info("published track (sid=%s) — mode=%s", publication.sid, self.mode)
        await self._publish_mode()

        for participant in self.room.remote_participants.values():
            for pub in participant.track_publications.values():
                if pub.track is not None:
                    self._maybe_adopt(pub.track, participant)

    async def aclose(self):
        self._closing = True
        if self._rvc_retry_task:
            self._rvc_retry_task.cancel()
        if self.process_task:
            self.process_task.cancel()
            try:
                await self.process_task  # lets the capture finalize its files
            except (asyncio.CancelledError, Exception):
                pass
        await self.rvc.close()
        await self.room.disconnect()


async def main():
    parser = argparse.ArgumentParser(description="LuminaStream RVC convert agent")
    parser.add_argument("--mode", choices=MODES, default="passthrough",
                        help="startup mode (default: passthrough)")
    parser.add_argument("--room", default=DEFAULT_ROOM)
    parser.add_argument("--identity", default=DEFAULT_IDENTITY)
    parser.add_argument("--rvc-url", default=os.environ.get("RVC_WS_URL", DEFAULT_RVC_WS_URL))
    parser.add_argument("--capture-dir", default=None, metavar="PATH",
                        help="write per-session diagnostic captures (WAVs + meta.jsonl) "
                             "under PATH; capture is fully disabled when absent")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    url, key, secret = load_credentials()
    token = mint_token(key, secret, args.room, args.identity)

    agent = ConvertAgent(args.room, args.identity, args.rvc_url, args.mode,
                         capture_dir=args.capture_dir)

    # Warm up RVC BEFORE joining the room — the stream never sees a cold model
    try:
        await agent.rvc.connect()
        log.info("RVC ready (warmup %.1fs)", agent.rvc.warmup_s)
    except Exception as exc:
        log.warning("RVC unavailable at startup: %s", exc)

    if args.mode == "convert" and agent.rvc.connected:
        agent._set_mode("convert")
    elif args.mode == "convert":
        agent._set_mode("passthrough", "rvc_unavailable")
        agent._ensure_rvc_retry()
    if not agent.rvc.connected:
        agent._ensure_rvc_retry()

    stats_task = asyncio.ensure_future(agent._stats_loop())
    try:
        await agent.start(url, token)
        await asyncio.Event().wait()  # run until Ctrl-C
    finally:
        stats_task.cancel()
        await agent.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("stopped by user")
