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

import knobs
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


def check_credentials(api_key, voice_id):
    """Names exactly what is missing, before any network call is attempted."""
    missing = [name for name, value in
               (("ELEVENLABS_API_KEY", api_key), ("ELEVENLABS_VOICE_ID", voice_id))
               if not value or not str(value).strip()]
    if missing:
        raise PreflightError(
            f"{' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} "
            f"missing from secrets.env (repo root, same file as the LIVEKIT_* "
            f"keys). The tts engine cannot start without "
            f"{'it' if len(missing) == 1 else 'them'}."
        )


async def fetch_voice(session, api_key, voice_id):
    """Validate the key AND the voice id in one call; raise plain English.

    Deliberately fails the run rather than falling back: a bad key or a voice
    that is not on this account is a deploy mistake, and discovering it from
    silent fallback settings hours later is worse than not starting.
    """
    try:
        async with session.get(f"https://{API_HOST}/v1/voices/{voice_id}",
                               headers={"xi-api-key": api_key}) as r:
            body = await r.text()
            if r.status in (401, 403):
                raise PreflightError(
                    "ElevenLabs rejected ELEVENLABS_API_KEY (HTTP %d). Check the "
                    "key in secrets.env — it may be mistyped, revoked, or from a "
                    "different account." % r.status)
            # An unknown voice comes back 400 with a voice_not_found code, not
            # the 404 you would expect — verified live against a bogus id.
            if r.status == 404 or "voice_not_found" in body:
                raise PreflightError(
                    f"ELEVENLABS_VOICE_ID {voice_id!r} does not exist on this "
                    f"account (HTTP {r.status}). Check the id in secrets.env "
                    "against the voice library.")
            if r.status != 200:
                raise PreflightError(
                    f"ElevenLabs voice lookup failed (HTTP {r.status}): {body[:160]}")
            return json.loads(body)
    except PreflightError:
        raise
    except Exception as exc:
        raise PreflightError(
            f"Could not reach {API_HOST} to verify credentials ({exc!r}). "
            "Check outbound network/DNS on this host.")


async def list_voices_strict(session, api_key):
    """GET /v1/voices, RAISING on failure — the keyring preflight's probe.

    The pool loop (convert_agent._preflight_pool) needs a listing failure to
    disqualify a candidate key loudly, not to hand back an empty selector.
    Raises PreflightError with the operator-sentence discipline; the key
    itself never appears in the message."""
    try:
        async with session.get(f"https://{API_HOST}/v1/voices",
                               headers={"xi-api-key": api_key}) as r:
            if r.status in (401, 403):
                raise PreflightError(
                    f"ElevenLabs rejected this key (HTTP {r.status}) on the voice "
                    "listing — it may be mistyped, revoked, or from a closed account.")
            if r.status != 200:
                body = (await r.text())[:160]
                raise PreflightError(
                    f"ElevenLabs voice listing failed (HTTP {r.status}): {body}")
            data = json.loads(await r.text())
    except PreflightError:
        raise
    except Exception as exc:
        raise PreflightError(
            f"Could not reach api.elevenlabs.io to list voices ({exc!r}). "
            "Check the VPS's network/DNS.")
    out = []
    for v in data.get("voices", []):
        vid = v.get("voice_id")
        if not vid:
            continue
        out.append({"voice_id": vid,
                    "name": v.get("name") or vid,
                    "category": v.get("category") or "voice"})
    log.info("listed %d account voices", len(out))
    return out


async def list_voices(session, api_key):
    """GET /v1/voices — the account's voices (cloned + ElevenLabs premade).

    A free GET (no synthesis), so it is NOT metered by the governor. Returns
    [{voice_id, name, category}]; an empty list on any failure — the selector is
    a convenience and a listing failure must never take the agent down. The
    shared community Voice Library is a SEPARATE surface (/v1/shared-voices plus
    an add step) and is deliberately out of scope here (see PR).

    The RAISING variant above serves the keyring preflight; this wrapper keeps
    the failure-silent contract for every runtime call site (refresh_voices)."""
    try:
        return await list_voices_strict(session, api_key)
    except PreflightError as exc:
        log.warning("could not list voices (%s) — selector stays empty", exc)
        return []


def voice_settings_from(voice):
    """The clone's own settings, so env overrides deviate from ITS baseline."""
    settings = voice.get("settings") or {}
    merged = dict(FALLBACK_VOICE_SETTINGS)
    merged.update({k: v for k, v in settings.items() if v is not None})
    log.info("voice %r (%s) settings: %s",
             voice.get("name"), voice.get("category"), merged)
    return merged


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


class PreflightError(Exception):
    """A configuration problem the operator can fix.

    Carried to the top and printed as a plain sentence. Amy deploys this by
    hand on the VPS, hand-typing two secrets into a file; the difference
    between "ELEVENLABS_API_KEY is missing from secrets.env" and a 30-line
    aiohttp traceback is the difference between a 10-second fix and a support
    round trip. Anything raised here must read like a message.
    """


class SttError(Exception):
    pass


class _SttConnectionLost(SttError):
    """The socket died under us — distinct from a vendor-level refusal.

    Only this class is retried: an auth_error or quota_exceeded would fail
    identically on a fresh socket and retrying would just spend twice.
    """


class TtsError(Exception):
    pass


class VendorAccountDead(Exception):
    """The active vendor account refused for MONEY reasons mid-run.

    Raised (once) from the engine's drop sites when a payment-class error is
    classified; the worker loop turns it into a clean self-restart so the
    keyring preflight can fail over to the next key in the pool. Never raised
    for transient errors — the classifier in vendor_keys.py is deliberately
    unreachable by timeouts, 429s, 5xx, and network noise."""


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
        self._uncommitted = False        # audio sent but never committed (see abandon_utterance)

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
        self._uncommitted = False        # a fresh socket has an empty segment buffer
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

    def abandon_utterance(self):
        """Drop a streamed span that never became an utterance (a VAD blip).

        The held hop is discarded, but audio already sent is sitting
        UNCOMMITTED in the server's segment buffer, where it would be prepended
        to whatever the next commit returns — a cough silently glued onto the
        front of the next sentence's transcript. `_uncommitted` records that, so
        the next begin_utterance() starts a clean session.
        """
        self._pending = None
        self._stream_ok = False

    async def begin_utterance(self):
        """Start streaming a new utterance. Failures degrade to the burst path."""
        try:
            if self._uncommitted:
                # Cheap here on purpose: this runs at gate-OPEN, so the
                # handshake hides behind the utterance the speaker is only just
                # starting, rather than landing in tail_latency at gate-close.
                log.info("discarding uncommitted audio from a dropped span — "
                         "reconnecting STT so it cannot leak into this utterance")
                await self.connect()
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
                self._uncommitted = True
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
            self._uncommitted = False
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
        # Request stitching (continuity): the "request-id" response header of the
        # last FULLY-READ synthesis, used to condition the next one. Verified
        # header name + streaming caveat against the ElevenLabs docs (29 Jul).
        self.last_request_id = None

    @property
    def url(self):
        # output_format MUST be a query param — in the body it is ignored and
        # the response silently comes back as 128 kbps MP3
        return (f"https://{API_HOST}/v1/text-to-speech/{self.voice_id}/stream"
                f"?output_format={TTS_OUTPUT_FORMAT}")

    # ── live tuning (Phase 4 console; applies to the NEXT utterance) ──
    #
    # stream() captures the body at call time, so mutating either of these
    # mid-synthesis never corrupts an in-flight request — it lands on the next
    # utterance, which is exactly the per-request semantics the console labels.

    def set_model(self, model_id):
        self.model = model_id

    def set_voice(self, voice_id, voice_settings=None):
        """Switch voice (used by url/ping/warmup and the next synthesis). When
        the new voice's own settings are supplied they replace the current ones
        — each voice carries its own defaults, so the applied-truth broadcast
        shows the values in effect for the NEW voice, not stale ones."""
        self.voice_id = voice_id
        if voice_settings is not None:
            self.voice_settings = dict(voice_settings)

    def apply_voice_setting(self, field, value):
        self.voice_settings[field] = value

    def effective_voice_settings(self):
        """voice_settings with fields the CURRENT model does not support removed.

        Defensive honesty rather than trusting the vendor to ignore them
        silently: Eleven v3, for instance, drops similarity_boost and
        use_speaker_boost (per the ElevenLabs docs — see knobs.py)."""
        return {k: v for k, v in self.voice_settings.items()
                if knobs.model_unsupported(k, self.model) is None}

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
        """POSITIVE PREFLIGHT: synthesize one character and prove the path works.

        Two jobs in one call. It warms the voice (the first synthesis of a run
        measured ~1000 ms TTFB against ~350 ms steady), and it is the assertion
        that the whole TTS path — key, voice, network, quota, audio format —
        actually functions, made BEFORE the agent joins a room and someone
        speaks into it. Same discipline as lk_smoke.py's `CONNECTED OK`: a
        deploy either prints TTS READY or says plainly what is wrong.

        Costs one billable character and is metered like everything else.
        """
        try:
            if governor is not None:
                governor.reserve_tts(1)
        except Exception as exc:
            raise PreflightError(
                f"The spend governor refused the 1-character preflight synthesis "
                f"({exc}). SPIKE_MAX_TTS_CHARS is set too low to start.")
        t0 = time.perf_counter()
        try:
            got_audio = False
            async for _chunk, _ttfb in self.stream("."):
                got_audio = True
                break                       # first chunk is all we need
        except TtsError as exc:
            raise PreflightError(
                f"TTS preflight synthesis failed: {exc}. The key and voice were "
                f"accepted, so this is the synthesis endpoint itself — check "
                f"quota/plan for model {self.model!r}.")
        if not got_audio:
            raise PreflightError(
                f"TTS preflight returned no audio for model {self.model!r}.")
        ttfb = (time.perf_counter() - t0) * 1000
        log.info("TTS READY (TTFB %.0f ms) — model=%s voice=%s",
                 ttfb, self.model, self.voice_id)
        return ttfb

    async def stream(self, text, previous_request_ids=None):
        """Yield (float32 chunk @48k, ttfb_ms) — ttfb_ms set on the first chunk only.

        `previous_request_ids` (request stitching) conditions this synthesis on
        prior ones so delivery holds across a session; the docs cap it at 3 ids.
        Raises TtsError; the caller drops the utterance and keeps streaming.
        """
        body = {"text": text, "model_id": self.model,
                "voice_settings": self.effective_voice_settings()}
        if previous_request_ids:
            body["previous_request_ids"] = list(previous_request_ids)[:3]
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
                # Body fully read → per the request-stitching docs its request-id
                # may now condition the NEXT synthesis (streaming requires the
                # complete read first). Header name verified as "request-id".
                self.last_request_id = resp.headers.get("request-id")
        except TtsError:
            raise
        except asyncio.TimeoutError:
            raise TtsError(f"synthesis exceeded {self.timeout_s:.0f}s")
        except Exception as exc:
            raise TtsError(f"stream error: {exc!r}")
        self.syntheses += 1
