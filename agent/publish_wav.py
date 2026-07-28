"""Publish a WAV into a LiveKit room in real time — the E2E harness.

The scripted stand-in for a human participant: joins as a normal (non-`echo-`)
identity so the agent adopts its track, then publishes a mono 48 kHz WAV paced
at real time in 10 ms frames, exactly as a browser mic would.

Real time pacing is the point. Blasting the file as fast as possible would
make the VAD gate, the jitter buffer and every latency number meaningless —
the agent would see an hour of audio in a second. The publisher therefore
sleeps against a monotonic schedule and reports the drift it accumulated, so a
run where the machine could not keep up is visible rather than silent.

  python publish_wav.py drill.wav [--room ...] [--identity drill-speaker]
                        [--hold 5] [--repeat 1]

--hold keeps the connection open after the audio ends, so the agent's last
utterance has time to come back before the room closes.
"""

import argparse
import asyncio
import logging
import time
import wave
from datetime import timedelta
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc

SAMPLE_RATE = 48000
NUM_CHANNELS = 1
FRAME = 480          # 10 ms, the LiveKit delivery unit

log = logging.getLogger("publish-wav")


def load_credentials():
    import os
    repo_root = Path(__file__).resolve().parent.parent
    load_dotenv(repo_root / "secrets.env")
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not url or not key or not secret:
        raise SystemExit("secrets.env must define LIVEKIT_URL/API_KEY/API_SECRET")
    return url, key, secret


def read_wav_mono48(path):
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16-bit PCM")
        if w.getframerate() != SAMPLE_RATE:
            raise SystemExit(f"{path}: need {SAMPLE_RATE} Hz, got {w.getframerate()}")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() == 2:
            data = data.reshape(-1, 2).mean(axis=1).astype(np.int16)
        elif w.getnchannels() != 1:
            raise SystemExit(f"{path}: need mono or stereo")
    return data


async def publish(path, url, token, room_name, identity, hold_s, repeat):
    samples = read_wav_mono48(path)
    room = rtc.Room()

    @room.on("data_received")
    def _on_data(packet):
        # The agent's per-utterance results come back here — printing them
        # makes the E2E self-verifying without reading the agent's log
        try:
            log.info("agent → %s", packet.data.decode("utf-8")[:400])
        except UnicodeDecodeError:
            pass

    await room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
    log.info("connected to %s as %s", room_name, identity)
    source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
    track = rtc.LocalAudioTrack.create_audio_track("drill", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    log.info("publishing %s (%.1fs) x%d", path, len(samples) / SAMPLE_RATE, repeat)

    t0 = time.monotonic()
    sent = 0
    max_drift = 0.0
    for _ in range(repeat):
        for off in range(0, len(samples) - FRAME + 1, FRAME):
            frame = rtc.AudioFrame.create(SAMPLE_RATE, NUM_CHANNELS, FRAME)
            np.frombuffer(frame.data, dtype=np.int16)[:] = samples[off:off + FRAME]
            await source.capture_frame(frame)
            sent += 1
            # pace against an absolute schedule so errors never accumulate
            target = t0 + sent * FRAME / SAMPLE_RATE
            drift = time.monotonic() - target
            max_drift = max(max_drift, drift)
            if drift < 0:
                await asyncio.sleep(-drift)
    log.info("published %d frames (%.1fs), max pacing drift %.0f ms",
             sent, sent * FRAME / SAMPLE_RATE, max_drift * 1000)
    if max_drift > 0.05:
        log.warning("pacing drift exceeded 50 ms — latency numbers from this run "
                    "are suspect (the publisher could not keep real time)")
    log.info("holding %.1fs for the agent's tail", hold_s)
    await asyncio.sleep(hold_s)
    await room.disconnect()


async def main():
    ap = argparse.ArgumentParser(description="Publish a WAV into a LiveKit room")
    ap.add_argument("wav", type=Path)
    ap.add_argument("--room", default="luminastream-test")
    ap.add_argument("--identity", default="drill-speaker")
    ap.add_argument("--hold", type=float, default=8.0,
                    help="seconds to stay connected after the audio ends")
    ap.add_argument("--repeat", type=int, default=1)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, datefmt="%H:%M:%S",
                        format="%(asctime)s %(levelname)-7s %(name)s — %(message)s")
    url, key, secret = load_credentials()
    token = (api.AccessToken(key, secret)
             .with_identity(args.identity)
             .with_name("Drill Speaker")
             .with_grants(api.VideoGrants(room_join=True, room=args.room))
             .with_ttl(timedelta(hours=1))
             .to_jwt())
    await publish(args.wav, url, token, args.room, args.identity,
                  args.hold, args.repeat)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("stopped by user")
