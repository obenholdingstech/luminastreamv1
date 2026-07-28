"""ElevenLabs STT + TTS clients for the spike's second engine.

Every transport choice below was measured live against the real API on 28 Jul
2026 (pro account) — see SPIKE.md for the full tables. The short version:

STT — realtime WebSocket, uploaded at 16 kHz
  `scribe_v2_realtime` on wss /v1/speech-to-text/realtime is the only model the
  realtime socket accepts (the batch ids `scribe_v2`/`scribe_v1` connect but
  never emit a transcript). It also beat the batch endpoint outright:
  871 ms p50 to final vs 2136 ms for POST /v1/speech-to-text with scribe_v2.
  Audio is decimated 48k→16k before upload — a 3.0x smaller payload that cut
  p50 latency-to-final from 1463 ms to 871 ms on this link with a byte-identical
  transcript. The decimator is the agent's own proven Resampler48to16 (vad.py),
  not a second implementation.
  The session is PERSISTENT: the handshake measured ~900 ms, which would
  otherwise be paid on every utterance and land directly in tail_latency. It
  reconnects on drop. Nothing is ever sent while the VAD gate is open — the
  whole utterance is burst-uploaded at gate-close with commit=True on the last
  chunk, so there is exactly one commit (one "STT call") per utterance.

TTS — HTTP POST /v1/text-to-speech/{voice}/stream
  Chosen over the stream-input WebSocket. That socket exists to accept text
  that is still being produced (by an LLM); we have the complete transcript the
  moment STT returns, so its chunk_length_schedule buffering is pure added
  latency. Measured TTFB, HTTP vs WS: flash_v2_5 365/642 ms,
  multilingual_v2 900/2460 ms, and eleven_v3 is REJECTED at WS handshake
  entirely — HTTP is also the only transport that covers all three models.
  `output_format` is a QUERY parameter; passing it in the JSON body is silently
  ignored and you get default 128 kbps MP3 back (caught during verification —
  it costs the same and decodes to plausible-looking garbage in a PCM path).
  pcm_48000 is accepted on this account, so synthesized audio enters the
  existing 48 kHz mono output path with no resampling at all.

Both clients are fail-open by contract: any error raises, and the caller drops
that one utterance and keeps the stream alive.
"""

import asyncio
import base64
import json
import logging
import os
import time

import aiohttp
import numpy as np

from vad import Resampler48to16

log = logging.getLogger("11labs")

API_HOST = "api.elevenlabs.io"
STT_MODEL = "scribe_v2_realtime"          # verified: the realtime-capable id
STT_UPLOAD_SR = 16000                     # 3x smaller than 48k, same transcript
STT_CHUNK_MS = 200
DEFAULT_TTS_MODEL = "eleven_flash_v2_5"
TTS_OUTPUT_FORMAT = "pcm_48000"           # native pipeline rate — no resampling
OUT_SR = 48000

# Fallback voice settings, used only if the API lookup fails. The real defaults
# are the ones the cloned voice itself carries (fetched in fetch_voice_settings)
# — the clone is the declared quality reference, so its own tuning is the
# baseline the env overrides deviate from.
FALLBACK_VOICE_SETTINGS = {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "use_speaker_boost": True,
    "speed": 1.0,
}

# env → voice_settings field. Expressiveness tuning is part of what the spike
# measures, so every one of these is logged per utterance alongside model_id.
VOICE_SETTING_ENV = {
    "stability": ("SPIKE_TTS_STABILITY", float),
    "similarity_boost": ("SPIKE_TTS_SIMILARITY_BOOST", float),
    "style": ("SPIKE_TTS_STYLE", float),
    "speed": ("SPIKE_TTS_SPEED", float),
    "use_speaker_boost": ("SPIKE_TTS_SPEAKER_BOOST", bool),
}


def _env_bool(raw):
    return raw.strip().lower() in ("1", "true", "yes", "on")


def resolve_voice_settings(base):
    """base (the voice's own settings) overlaid with SPIKE_TTS_* env overrides."""
    settings = dict(base)
    for field, (env_name, cast) in VOICE_SETTING_ENV.items():
        raw = os.environ.get(env_name)
        if raw is None or raw.strip() == "":
            continue
        try:
            settings[field] = _env_bool(raw) if cast is bool else cast(raw.strip())
        except (TypeError, ValueError):
            log.warning("ignoring %s=%r — not a %s", env_name, raw, cast.__name__)
    return settings


async def fetch_voice_settings(session, api_key, voice_id):
    """The clone's own settings, so env overrides deviate from ITS baseline."""
    try:
        async with session.get(f"https://{API_HOST}/v1/voices/{voice_id}",
                               headers={"xi-api-key": api_key}) as r:
            if r.status != 200:
                raise RuntimeError(f"{r.status}: {(await r.text())[:120]}")
            voice = await r.json()
        settings = voice.get("settings") or {}
        merged = dict(FALLBACK_VOICE_SETTINGS)
        merged.update({k: v for k, v in settings.items() if v is not None})
        log.info("voice %r (%s) settings: %s",
                 voice.get("name"), voice.get("category"), merged)
        return merged
    except Exception as exc:
        log.warning("voice lookup failed (%s) — using fallback settings", exc)
        return dict(FALLBACK_VOICE_SETTINGS)


def pcm48_to_pcm16k_bytes(pcm48, resampler=None):
    """float32 @48k → int16 little-endian bytes @16k, for STT upload.

    Resampler48to16 requires a length that is a multiple of 3; the remainder
    (at most 2 samples = 42 µs) is dropped from the tail.
    """
    pcm48 = np.asarray(pcm48, dtype=np.float32)
    usable = len(pcm48) - (len(pcm48) % 3)
    if usable <= 0:
        return b""
    down = (resampler or Resampler48to16()).process(pcm48[:usable])
    return (np.clip(down, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class SttError(Exception):
    pass


class _SttConnectionLost(SttError):
    """The socket died under us — distinct from a vendor-level refusal.

    Only this class is retried: an auth_error or quota_exceeded would fail
    identically on a fresh socket and retrying would just spend twice.
    """


class TtsError(Exception):
    pass


class SttClient:
    """Persistent realtime-STT socket; one commit per utterance.

    transcribe() is NOT re-entrant — the agent drives it from a single
    utterance worker so commits can never interleave on the shared socket.
    """

    def __init__(self, session, api_key, model=STT_MODEL, timeout_s=20.0):
        self.session = session
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self._ws = None
        self._resampler = None
        self.utterances = 0
        self.reconnects = 0
        self.stale_retries = 0
        self.commits = 0                 # streamed utterances
        self.fallbacks = 0               # utterances that had to burst-upload
        self._stream_resampler = None
        self._pending = None             # newest hop, held back to carry the commit
        self._stream_ok = False

    @property
    def url(self):
        return (f"wss://{API_HOST}/v1/speech-to-text/realtime"
                f"?model_id={self.model}&audio_format=pcm_{STT_UPLOAD_SR}"
                "&commit_strategy=manual")

    async def connect(self):
        """Open the session (and reset the decimator — its filter state is
        per-stream, and a fresh socket starts a fresh stream)."""
        await self.close()
        t0 = time.perf_counter()
        self._ws = await self.session.ws_connect(
            self.url, headers={"xi-api-key": self.api_key})
        self._resampler = Resampler48to16()
        log.info("STT session open (%s, handshake %.0f ms)",
                 self.model, (time.perf_counter() - t0) * 1000)

    async def close(self):
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    async def _ensure(self):
        if self._ws is None or self._ws.closed:
            if self._ws is not None:
                self.reconnects += 1
                log.warning("STT socket closed — reconnecting")
            await self.connect()

    # ── streaming path (the fast one) ────────────────────────────────
    #
    # Audio goes out WHILE the speaker is still talking, so at gate-close only
    # the final hop and a commit remain. Measured: commit→final 311 ms p50
    # versus 860 ms for burst-uploading the same utterance afterwards.
    #
    # The last hop is deliberately HELD BACK and sent as the commit itself.
    # The alternative — committing with a chunk of digital silence — measured
    # marginally slower (332 ms) and injects audio the speaker never produced.
    #
    # INVARIANT: commits are issued from the frame path in gate-close order and
    # consumed by the single utterance worker in the same order, so exactly one
    # commit is outstanding per queued utterance and transcripts cannot be
    # mismatched. Pushes for the NEXT utterance may safely interleave with an
    # awaited final — the server treats a commit as the segment boundary.

    async def begin_utterance(self):
        """Start streaming a new utterance. Failures degrade to the burst path."""
        try:
            await self._ensure()
        except Exception as exc:
            self._stream_ok = False
            log.warning("STT unavailable at utterance start (%s) — will burst-upload", exc)
            return False
        self._stream_resampler = Resampler48to16()
        self._pending = None
        self._stream_ok = True
        return True

    async def push(self, pcm48):
        """Send one hop, holding the newest back so a real chunk can carry the commit."""
        if not self._stream_ok:
            return
        try:
            buf = pcm48_to_pcm16k_bytes(pcm48, self._stream_resampler)
            if self._pending is not None:
                await self._send_chunk(self._pending, False)
            self._pending = buf
        except Exception as exc:
            self._stream_ok = False
            self._pending = None
            log.warning("STT streaming broke mid-utterance (%s) — this utterance "
                        "falls back to burst upload", exc)

    async def commit(self):
        """Flush the held hop with commit=True. True if a final is now pending."""
        if not self._stream_ok or self._pending is None:
            self._stream_ok = False
            return False
        try:
            await self._send_chunk(self._pending, True)
            self.commits += 1
            return True
        except Exception as exc:
            log.warning("STT commit failed (%s) — falling back to burst upload", exc)
            return False
        finally:
            self._pending = None
            self._stream_ok = False

    async def await_final(self):
        """Await the transcript for the oldest outstanding commit."""
        try:
            return await asyncio.wait_for(self._await_final(), self.timeout_s)
        except asyncio.TimeoutError:
            await self.close()
            raise SttError(f"no final transcript within {self.timeout_s:.0f}s")

    async def _send_chunk(self, buf, commit):
        await self._ws.send_json({
            "message_type": "input_audio_chunk",
            "audio_base_64": base64.b64encode(buf).decode(),
            "commit": commit,
        })

    # ── burst path (the fallback) ────────────────────────────────────

    async def transcribe(self, pcm48):
        """Burst-upload one complete utterance and wait for its final transcript.

        Returns (text, elapsed_ms). Raises SttError; the caller drops the
        utterance and the stream survives.

        Retries ONCE on connection loss. The session idles out server-side
        during a quiet spell, and `_ensure` cannot see it: the socket still
        reads as open, the send succeeds, and only the read discovers it is
        dead — losing that utterance. Observed live, costing the first sentence
        after a two-minute pause. A stale socket is not the speaker's fault, so
        the retry is on a fresh connection with the audio already in hand.
        """
        await self._ensure()
        # A fresh decimator: this is a complete, independent utterance, and the
        # streaming path may have left the shared one mid-stream.
        audio = pcm48_to_pcm16k_bytes(pcm48)
        if not audio:
            raise SttError("utterance too short to upload")
        try:
            text, ms = await self._send_and_wait(audio)
        except _SttConnectionLost as exc:
            self.stale_retries += 1
            log.warning("STT session was stale (%s) — retrying once on a fresh "
                        "socket; the utterance is not lost", exc)
            await self.connect()
            text, ms = await self._send_and_wait(audio)  # a second loss is fatal
        self.utterances += 1
        return text, ms

    async def _send_and_wait(self, audio):
        per = int(STT_UPLOAD_SR * STT_CHUNK_MS / 1000) * 2
        offsets = list(range(0, len(audio), per))
        t0 = time.perf_counter()
        try:
            for i, off in enumerate(offsets):
                await self._ws.send_json({
                    "message_type": "input_audio_chunk",
                    "audio_base_64": base64.b64encode(audio[off:off + per]).decode(),
                    "commit": i == len(offsets) - 1,
                })
            text = await asyncio.wait_for(self._await_final(), self.timeout_s)
        except asyncio.TimeoutError:
            await self.close()
            raise SttError(f"no final transcript within {self.timeout_s:.0f}s")
        except SttError:
            raise
        except Exception as exc:
            await self.close()
            raise _SttConnectionLost(f"socket error: {exc!r}")
        return text, (time.perf_counter() - t0) * 1000

    async def _await_final(self):
        async for msg in self._ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            kind = data.get("message_type", "")
            if kind.startswith("committed_transcript"):
                return (data.get("text") or "").strip()
            if "error" in kind:
                # A vendor refusal (auth, quota, rate limit) — NOT retryable
                raise SttError(f"{kind}: {data.get('error')}")
        raise _SttConnectionLost("socket closed before a final transcript")


class TtsClient:
    """HTTP streaming synthesis straight to 48 kHz mono PCM."""

    def __init__(self, session, api_key, voice_id, model=DEFAULT_TTS_MODEL,
                 voice_settings=None, timeout_s=30.0):
        self.session = session
        self.api_key = api_key
        self.voice_id = voice_id
        self.model = model
        self.voice_settings = dict(voice_settings or FALLBACK_VOICE_SETTINGS)
        self.timeout_s = timeout_s
        self.syntheses = 0

    @property
    def url(self):
        # output_format MUST be a query param — in the body it is ignored and
        # the response silently comes back as 128 kbps MP3
        return (f"https://{API_HOST}/v1/text-to-speech/{self.voice_id}/stream"
                f"?output_format={TTS_OUTPUT_FORMAT}")

    async def ping(self):
        """Free GET that keeps the pooled TLS connection to the API alive.

        A one-character warmup at startup did NOT fix the first utterance's
        TTFB (1028 ms vs ~350 ms steady): the connection then sat idle for ~40 s
        while waiting for someone to speak, and an idle pooled connection is
        reaped — so the first real synthesis paid a full reconnect anyway.
        Warming once is useless if nothing keeps it warm.
        """
        try:
            async with self.session.get(
                    f"https://{API_HOST}/v1/voices/{self.voice_id}",
                    headers={"xi-api-key": self.api_key}) as r:
                await r.read()
            return True
        except Exception as exc:
            log.debug("TTS keepalive ping failed: %s", exc)
            return False

    async def warmup(self, governor=None):
        """Synthesize one character before the room join, discarding the audio.

        The first synthesis of a run measured 993 ms TTFB against ~376 ms
        steady-state — a cold-voice penalty that landed entirely in the first
        utterance's tail and dominated p95. Same philosophy as the RVC warmup:
        the stream never sees a cold model. Costs one billable character, and
        goes through the governor like everything else.
        """
        try:
            if governor is not None:
                governor.reserve_tts(1)
            t0 = time.perf_counter()
            async for _chunk, _ttfb in self.stream("."):
                break                       # first chunk is all we need
            log.info("TTS voice warm (%.0f ms, 1 char)",
                     (time.perf_counter() - t0) * 1000)
            return True
        except Exception as exc:
            log.warning("TTS warmup failed (%s) — first utterance may be slow", exc)
            return False

    async def stream(self, text):
        """Yield (float32 chunk @48k, ttfb_ms) — ttfb_ms set on the first chunk only.

        Raises TtsError; the caller drops the utterance and keeps streaming.
        """
        body = {"text": text, "model_id": self.model,
                "voice_settings": self.voice_settings}
        t0 = time.perf_counter()
        ttfb = None
        tail = b""
        timeout = aiohttp.ClientTimeout(total=self.timeout_s)
        try:
            async with self.session.post(
                    self.url, json=body, timeout=timeout,
                    headers={"xi-api-key": self.api_key}) as resp:
                if resp.status != 200:
                    raise TtsError(f"HTTP {resp.status}: {(await resp.text())[:160]}")
                async for chunk in resp.content.iter_any():
                    if not chunk:
                        continue
                    if ttfb is None:
                        ttfb = (time.perf_counter() - t0) * 1000
                    buf = tail + chunk
                    usable = len(buf) - (len(buf) % 2)  # int16 frames may split
                    tail = buf[usable:]
                    if usable:
                        pcm = (np.frombuffer(buf[:usable], dtype="<i2")
                               .astype(np.float32) / 32768.0)
                        yield pcm, ttfb
                        ttfb = None
        except TtsError:
            raise
        except asyncio.TimeoutError:
            raise TtsError(f"synthesis exceeded {self.timeout_s:.0f}s")
        except Exception as exc:
            raise TtsError(f"stream error: {exc!r}")
        self.syntheses += 1
