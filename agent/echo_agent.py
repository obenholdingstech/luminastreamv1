"""LuminaStream echo agent — first server-side piece of the voice engine (Stage 1).

Joins the LiveKit room as "echo-agent", subscribes to the human participant's
audio track, and republishes the frames UNCHANGED as its own track. This proves
the server-side WebRTC path (subscribe → process → publish) that the real
voice-conversion GPU worker will later occupy; the passthrough is where the
model inference will slot in.

Uses the plain `livekit` rtc SDK, not the `livekit-agents` framework — the
framework is built around STT/LLM/TTS pipelines and adds worker/dispatch
plumbing we don't need for raw frame passthrough. Revisit when the real
voice-conversion worker needs orchestration.

Run:  python echo_agent.py   (see README.md; reads ../secrets.env)
"""

import asyncio
import logging
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from livekit import api, rtc

ROOM_NAME = "luminastream-test"
IDENTITY = "echo-agent"

# WebRTC-native format. AudioStream resamples whatever the browser sends to
# this, and the publishing AudioSource is created to match, so frames pass
# straight through with no conversion on our side.
SAMPLE_RATE = 48000
NUM_CHANNELS = 1

STATS_INTERVAL_S = 5

log = logging.getLogger("echo-agent")


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


def mint_token(key, secret):
    """Server-side token for the agent's own identity (distinct from test-user)."""
    return (
        api.AccessToken(key, secret)
        .with_identity(IDENTITY)
        .with_name("Echo Agent")
        .with_grants(api.VideoGrants(room_join=True, room=ROOM_NAME))
        .with_ttl(timedelta(hours=2))
        .to_jwt()
    )


class EchoAgent:
    def __init__(self):
        self.room = rtc.Room()
        self.source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
        self.echo_task = None
        self.echoed_identity = None
        self.frames_received = 0
        self.frames_published = 0
        self.frames_dropped = 0
        self._register_handlers()

    # ── Room event logging + track adoption ──────────────────────────

    def _register_handlers(self):
        room = self.room

        @room.on("connection_state_changed")
        def _on_state(state):
            try:
                name = rtc.ConnectionState.Name(state)
            except ValueError:
                name = str(state)
            log.info("connection state: %s", name)

        @room.on("reconnecting")
        def _on_reconnecting():
            log.warning("reconnecting…")

        @room.on("reconnected")
        def _on_reconnected():
            log.info("reconnected")

        @room.on("disconnected")
        def _on_disconnected(reason):
            log.warning("disconnected from room: %s", reason)

        @room.on("participant_connected")
        def _on_participant(p):
            log.info("participant connected: %s", p.identity)

        @room.on("participant_disconnected")
        def _on_participant_gone(p):
            log.info("participant disconnected: %s", p.identity)

        @room.on("track_subscription_failed")
        def _on_sub_failed(participant, track_sid, error):
            log.error("track subscription failed for %s (%s): %s", participant.identity, track_sid, error)

        @room.on("track_subscribed")
        def _on_track(track, publication, participant):
            self._maybe_adopt(track, participant)

        @room.on("track_unsubscribed")
        def _on_track_gone(track, publication, participant):
            if participant.identity == self.echoed_identity and self.echo_task:
                log.info("echoed track from %s went away — stopping echo", participant.identity)
                self.echo_task.cancel()

    def _maybe_adopt(self, track, participant):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if participant.identity.startswith("echo-"):
            log.info("ignoring audio from fellow agent %s", participant.identity)
            return
        if self.echo_task and not self.echo_task.done():
            log.warning(
                "already echoing %s — ignoring additional audio from %s",
                self.echoed_identity,
                participant.identity,
            )
            return
        self.echoed_identity = participant.identity
        self.echo_task = asyncio.ensure_future(self._echo(track, participant.identity))

    # ── The passthrough loop ─────────────────────────────────────────

    async def _echo(self, track, identity):
        log.info("echo started: %s → %s/%dHz mono passthrough", identity, IDENTITY, SAMPLE_RATE)
        stream = rtc.AudioStream.from_track(
            track=track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS
        )
        try:
            async for event in stream:
                self.frames_received += 1
                try:
                    # Blocks (awaits) until the source buffer accepts the frame —
                    # that IS the flow control; failures are counted as drops
                    await self.source.capture_frame(event.frame)
                    self.frames_published += 1
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.frames_dropped += 1
                    if self.frames_dropped in (1, 10, 100) or self.frames_dropped % 1000 == 0:
                        log.error("dropped frame #%d: %s", self.frames_dropped, exc)
        except asyncio.CancelledError:
            pass
        finally:
            await stream.aclose()
            log.info("echo ended for %s", identity)
            self.echoed_identity = None

    async def _stats_loop(self):
        prev = (0, 0, 0)
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            cur = (self.frames_received, self.frames_published, self.frames_dropped)
            log.info(
                "stats: received=%d (+%d) published=%d (+%d) dropped=%d (+%d)",
                cur[0], cur[0] - prev[0],
                cur[1], cur[1] - prev[1],
                cur[2], cur[2] - prev[2],
            )
            prev = cur

    # ── Lifecycle ────────────────────────────────────────────────────

    async def start(self, url, token):
        # Logged here rather than from the "connected" room event — in livekit
        # 1.1.13 that event does not fire for the initial connect, only
        # connection_state_changed does (observed live)
        await self.room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
        log.info("connected to room %s as %s", ROOM_NAME, IDENTITY)

        local_track = rtc.LocalAudioTrack.create_audio_track("echo", self.source)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        publication = await self.room.local_participant.publish_track(local_track, options)
        log.info("published echo track (sid=%s) — waiting for a human participant", publication.sid)

        # Adopt tracks that were already in the room before we joined
        for participant in self.room.remote_participants.values():
            for pub in participant.track_publications.values():
                if pub.track is not None:
                    self._maybe_adopt(pub.track, participant)

    async def aclose(self):
        if self.echo_task:
            self.echo_task.cancel()
        await self.room.disconnect()


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    url, key, secret = load_credentials()
    token = mint_token(key, secret)

    agent = EchoAgent()
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
