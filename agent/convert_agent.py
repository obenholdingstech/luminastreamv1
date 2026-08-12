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

Phase 3: a Silero VAD gate (vad.py) sits between the assembler and the RVC
websocket — only speech hops (plus a hangover tail) are sent; gated periods
become clean silence on the output with equal-power edge ramps. Fail-open:
if the model can't load or errors, the agent runs ungated (same philosophy
as the RVC-failure fallback). --no-vad disables it entirely.

ENGINES (--engine, DEFAULT tts since 28 Jul 2026):
  tts  STT→TTS through the cloned voice — the promoted default. The Phase 3 VAD
       gate stops being a noise gate and becomes an utterance endpointer:
       speech streams to ElevenLabs Scribe v2 Realtime while the gate is open,
       and at gate-close a commit yields the transcript, which is re-spoken in
       the cloned voice and streamed back through this same output path. The
       RVC client is never constructed in this mode. Every billable call is
       metered by spend_governor.py, and startup runs a positive preflight
       (STT READY / TTS READY / PREFLIGHT OK) before joining a room.
  rvc  the parked baseline and fallback — unchanged, fully supported, nothing
       removed. Everything above this line describes it.
See SPIKE.md for the measurements behind the pivot.

Run:  python convert_agent.py [--engine tts|rvc] [--mode passthrough|convert]
      [--capture-dir PATH] [--no-vad] [--vad-threshold 0.5]
      [--vad-hangover-ms 300]
      RVC_WS_URL=ws://127.0.0.1:8000/ws/audio (default; see README.md)
      --engine tts: [--tts-model eleven_flash_v2_5] [--drill-script PATH]
      ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID from secrets.env;
      SPIKE_MAX_TTS_CHARS / SPIKE_MAX_STT_SECONDS cap the run's spend.
The RVC server must run with RVC_STREAM_CONTEXT_SECONDS=0 (stateless windows).
"""

import argparse
import asyncio
import json
import logging
import os
import signal
from datetime import timedelta
from pathlib import Path

import aiohttp
import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc

import knobs
import wer
from bridge import CTX, HOP, SOLA, XFADE, SolaStitcher, WindowAssembler
from capture import SessionCapture
from elevenlabs_client import (
    DEFAULT_TTS_MODEL,
    PreflightError,
    SttClient,
    TtsClient,
    check_credentials,
    fetch_voice,
    list_voices,
    list_voices_strict,
    resolve_voice_settings,
    voice_settings_from,
)
import vendor_keys
from endpointer import PcmQueue, UtteranceEndpointer
from rvc_client import RvcClient
from tts_engine import TtsEngine
from vad import DEFAULT_HANGOVER_MS, DEFAULT_THRESHOLD, OutputGate, VadGate

DEFAULT_ROOM = "luminastream-test"
DEFAULT_IDENTITY = "echo-convert-agent"  # echo-* prefix: agents ignore each other
DEFAULT_RVC_WS_URL = "ws://127.0.0.1:8000/ws/audio"

SAMPLE_RATE = 48000
NUM_CHANNELS = 1

MODES = ("passthrough", "convert")
ENGINES = ("rvc", "tts")
MAX_IN_FLIGHT = 2      # beyond this, drop the hop — late audio is worse than lost audio
PRIME_SAMPLES = int(1.5 * HOP)  # jitter buffer: drain only after ~1.5 hops buffered
RVC_RETRY_S = 5.0
STATS_INTERVAL_S = 5

log = logging.getLogger("convert-agent")


def _app_version():
    """Repo package version, for the agent_config broadcast + export metadata.

    Read once at import; a missing/broken package.json is not fatal (the
    version is metadata, not a guardrail) — it degrades to '0.0.0'."""
    try:
        pkg = Path(__file__).resolve().parent.parent / "package.json"
        return json.loads(pkg.read_text()).get("version") or "0.0.0"
    except Exception:
        return "0.0.0"


APP_VERSION = _app_version()

# Committed config-as-code profile (agent/tts_profile.json). Precedence at
# startup: CLI/env > profile > clone-settings/registry defaults.
PROFILE_PATH = Path(__file__).resolve().parent / "tts_profile.json"


def load_profile(path):
    """Read the committed tts profile → dict, or {} if absent.

    A malformed profile is FATAL rather than silently ignored: it is
    config-as-code committed via PR, and config that quietly reverts to
    defaults is a rumor — same doctrine as the governor's env caps. A MISSING
    profile is fine (registry defaults + the clone's own settings stand)."""
    p = Path(path)
    if not p.exists():
        log.info("no tts profile at %s — registry defaults + clone settings stand", p)
        return {}
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError) as exc:
        raise SystemExit(
            f"tts profile {p} is unreadable or invalid JSON ({exc}). Fix or "
            f"remove it — refusing to start on a broken committed profile.")
    if not isinstance(data, dict):
        raise SystemExit(
            f"tts profile {p} must be a JSON object, got {type(data).__name__}.")
    return data


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


def voice_policy_from_metadata(metadata):
    """Parse a participant's token-carried voice policy (P4c, 7 Aug 2026).

    The Worker stamps every join token it mints: {"voicePolicy": "all"} for
    admins and the ops path, {"voicePolicy": "own", "voices": [ids...]} for
    ordinary users. The claim rides the token's signature, so the client can
    no more edit it than extend its own expiry.

    Absent or malformed metadata fails CLOSED to ("own", frozenset()) — a
    token without a policy hears the premade set, never the account's clone
    list. (Agent-to-agent identities never call this; they don't switch
    voices.)

    Returns ("all", None) or ("own", frozenset of vendor voice ids).
    """
    if metadata:
        try:
            data = json.loads(metadata)
        except (TypeError, ValueError):
            data = None
        if isinstance(data, dict):
            mode = data.get("voicePolicy")
            if mode == "all":
                return ("all", None)
            if mode == "own":
                voices = data.get("voices")
                ids = (frozenset(v for v in voices if isinstance(v, str))
                       if isinstance(voices, list) else frozenset())
                return ("own", ids)
    return ("own", frozenset())


def voice_allowed(policy, voice):
    """May this policy use this account voice (a dict from list_voices)?

    'all' hears everything; 'own' hears the vendor's premade furniture plus
    exactly the clone ids the Worker signed into the token. The category
    check is deliberately == "premade": an unknown/missing category is a
    clone-shaped stranger and stays hidden.
    """
    mode, ids = policy
    if mode == "all":
        return True
    return voice.get("category") == "premade" or voice.get("voice_id") in ids


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
    def __init__(self, room_name, identity, rvc_url, requested_mode, capture_dir=None,
                 vad=None, engine="rvc", tts_engine=None):
        self.room_name = room_name
        self.identity = identity
        self.rvc_url = rvc_url
        # "tts" is the CLI default since 28 Jul 2026 (see --engine). This
        # constructor keeps "rvc" as ITS default deliberately: engine="tts"
        # requires a live tts_engine to take the queue/outgate from, so a
        # no-argument construction must land on the engine that needs nothing.
        self.engine = engine
        self.capture_dir = capture_dir  # None ⇒ capture fully disabled
        self.capture = None             # SessionCapture while a session runs
        self.room = rtc.Room()
        self.source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)

        self.mode = "passthrough"          # actual mode (source of truth)
        self.requested_mode = requested_mode  # what the user asked for last
        self.mode_reason = None

        self.assembler = WindowAssembler()
        self.vad = vad                     # VadGate or None (--no-vad)
        # TTS mode swaps the jitter buffer (contiguous PCM instead of SOLA-
        # stitched overlapping windows) and nothing else on the output side:
        # the OutputGate and the publisher below are the same objects either way.
        self.tts = tts_engine              # TtsEngine or None
        if engine == "tts":
            self.stitcher = tts_engine.queue
            self.outgate = tts_engine.outgate
            # The engine is built before the agent (its clients must exist to
            # be warmed up), so its sinks are attached here rather than passed in
            tts_engine._on_event = self._tts_event
            tts_engine._on_notice = self._tts_notice
        else:
            self.stitcher = SolaStitcher()
            self.outgate = OutputGate(self.stitcher, PRIME_SAMPLES)
        self.windows_gated = 0             # hops withheld from RVC by the VAD
        self._vad_fail_published = False   # fail-open reported once on the data channel
        self._tts_vad_fallback_fired = False  # tts fail-open handled once, not per frame
        # Fire-and-forget keepalive: the loop only holds weak refs to tasks, so
        # every ensure_future goes through _spawn and lives here until done
        self._bg_tasks = set()
        # Applies are strictly FIFO: without this, two in-flight _apply_config
        # tasks could interleave their RVC settings frames and leave the server
        # on an older value than the applied-truth broadcast claims — and with
        # no server-side settings echo, nothing would self-correct.
        self._config_lock = asyncio.Lock()
        self._last_hop_seq = 0             # context-accounting monotonicity assert
        # SPIKE: in tts mode the RVC client is never constructed — no socket, no
        # warmup, no GPU. Every rvc touchpoint below is guarded on this being None.
        self.rvc = None if engine == "tts" else RvcClient(
            rvc_url,
            on_window=self._on_converted,
            on_disconnect=self._on_rvc_drop,
        )
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

    def _spawn(self, coro):
        """ensure_future with a strong reference held until the task finishes."""
        task = asyncio.ensure_future(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)
        return task

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
            # Late joiners need to know the current mode and config immediately
            self._spawn(self._publish_mode())
            self._spawn(self._publish_config())
            # WARM-ON-JOIN (VPS drill 29 Jul): warm the vendor voice model now so
            # THIS participant's first utterance doesn't pay the cold-start TTFB
            # (2220 ms observed after a long idle vs ~100 ms steady). Skipped for
            # fellow agents (echo-*), which never speak into the room.
            if self.tts is not None and not p.identity.startswith("echo-"):
                self._spawn(self.tts.warm_on_join())

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
            # Tell the room, don't just log it. One agent adopts exactly one
            # speaker; anyone arriving second gets silence back and no reason
            # for it. Silence that looks like a broken pipeline is the worst
            # failure mode we ship — a second speaker must be able to see that
            # they are being ignored, and by whom. Room-per-session removes
            # the condition; until then this makes it legible.
            #
            # Snapshot the incumbent HERE, not inside the background task.
            # _publish_busy runs later; by then _process cleanup may have
            # cleared processed_identity and the broadcast would name nobody.
            holder = self.processed_identity
            # Same reasoning for the capture event: record it at the rejection
            # point so it lands on the session that actually rejected, rather
            # than on whichever capture object exists when the task is polled.
            if self.capture:
                self.capture.event("agent_busy", processing=holder,
                                   ignored=participant.identity,
                                   reason="one_speaker_per_agent")
            self._spawn(self._publish_busy(participant.identity, holder))
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
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "set_config":
            log.info("set_config from %s: %s", who, msg.get("params"))
            # P4c: the sender's token-carried policy travels WITH the request —
            # enforcement keys on the signed claim of whoever asked, never on
            # room-global state that another participant could have set.
            policy = voice_policy_from_metadata(
                packet.participant.metadata if packet.participant else None)
            # _spawn keeps every in-flight application alive — rapid successive
            # set_config messages must not drop a running task's only reference
            self._spawn(self._apply_config(msg.get("params"), who, policy))
            return
        if msg.get("type") == "refresh_voices":
            log.info("refresh_voices from %s", who)
            if self.tts is not None:
                self._spawn(self._refresh_voices(who))
            return
        if msg.get("type") != "set_mode":
            return
        mode = msg.get("mode")
        if mode not in MODES:
            log.warning("ignoring set_mode with invalid mode %r from %s", mode, who)
            return
        log.info("set_mode(%s) from %s", mode, who)
        self.requested_mode = mode
        self._spawn(self._apply_mode(mode))

    async def _apply_mode(self, mode, reason=None):
        if mode == "convert" and self.rvc is not None and not self.rvc.connected:
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
            self.outgate.reset()
            if self.tts is not None:
                # Full engine reset, not just the input buffer: queued and
                # in-flight syntheses from the previous take would otherwise
                # push ghost audio into the freshly-cleared jitter buffer.
                self.tts.reset()
            self._min_valid_seq = self.assembler.seq + 1
        else:
            # Anything still in flight is now stale
            self._min_valid_seq = self.assembler.seq + 1
        self.mode = mode
        self.mode_reason = reason
        if self.capture:
            self.capture.event("mode_change", mode=mode, reason=reason)
        log.info("mode → %s%s", mode, f" ({reason})" if reason else "")

    async def _publish_busy(self, ignored_identity, holder_identity):
        """Broadcast that a second speaker is being ignored.

        `holder_identity` is passed in rather than read from self: this runs
        as a background task, and by the time it is polled `_process` cleanup
        may have cleared `processed_identity`, which would broadcast
        "processing": null and name nobody. The capture event is written by
        the caller at the rejection point for the same reason.

        Additive and backward-compatible: older frontends do not know the
        `agent_busy` type and ignore it, exactly as they ignore unknown keys
        on `agent_mode`.
        """
        if self.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            return
        payload = {
            "type": "agent_busy",
            "processing": holder_identity,
            "ignored": ignored_identity,
            "reason": "one_speaker_per_agent",
        }
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload), reliable=True
            )
        except Exception as exc:
            log.error("failed to publish agent_busy: %s", exc)

    async def _publish_mode(self):
        if self.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            return
        payload = {"type": "agent_mode", "mode": self.mode}
        if self.mode_reason:
            payload["reason"] = self.mode_reason
        # Additive, backward-compatible: the current frontend only reads
        # type/mode/reason (verified in useLiveKitVoice.js) and ignores extras.
        # Phase 4's console consumes this.
        if self.vad is not None:
            payload["vad"] = {
                "enabled": self.vad.active,
                "gate": "open" if self.vad.gate_open else "closed",
                "threshold": self.vad.threshold,
                "hangover_ms": self.vad.hangover_ms,
            }
            if self.vad.fail_reason:
                payload["vad"]["reason"] = self.vad.fail_reason
        else:
            payload["vad"] = {"enabled": False, "reason": "disabled_by_flag"}
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload), reliable=True
            )
        except Exception as exc:
            log.error("failed to publish agent_mode: %s", exc)

    # ── TTS engine sinks (SPIKE) ─────────────────────────────────────

    def _tts_event(self, kind, **fields):
        """Utterance events into meta.jsonl, so analyze_capture.py can align
        them against the input/output waveforms on the shared t/in_pos/out_pos
        timeline every capture event already carries."""
        if self.capture:
            self.capture.event(kind, **fields)

    def _tts_notice(self, payload):
        """Per-utterance results (and governor skips) onto the data channel."""
        self._spawn(self._publish_json(payload))

    async def _publish_json(self, payload):
        if self.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            return
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload), reliable=True)
        except Exception as exc:
            log.error("failed to publish %s: %s", payload.get("type"), exc)

    # ── Tuning knobs (Phase 4) ───────────────────────────────────────

    def config_snapshot(self):
        """The full APPLIED tuning config — the only truth the UI renders."""
        snap = {"prime_hops": round(self.outgate.prime_samples / HOP, 3)}
        if self.rvc is not None:
            snap.update({
                "index_rate": self.rvc.config.get("index_rate"),
                "protect": self.rvc.config.get("protect"),
                "rms_mix_rate": self.rvc.config.get("rms_mix_rate"),
                "f0_method": self.rvc.config.get("f0_method"),
            })
        else:
            # SPIKE: the tts engine's own applied truth, same contract
            vs = dict(self.tts.tts.voice_settings)
            voice_id = self.tts.tts.voice_id
            voice_name = next((v["name"] for v in self.tts.voices
                               if v["voice_id"] == voice_id), None)
            comfort = self.outgate.comfort
            snap.update({
                "engine": "tts",
                "voice": voice_id,                     # flat knob key (dynamic enum)
                "voice_name": voice_name,              # display name / export metadata
                "tts_model": self.tts.tts.model,       # flat, matches the knob name
                "tts_model_id": self.tts.tts.model,    # legacy key kept for records
                "stt_model_id": self.tts.stt.model,
                "voice_settings": vs,                  # nested, for capture records
                "request_continuity": self.tts.request_continuity,
                "min_speech_ms": self.tts.endpointer.min_speech_ms,
                "queue_wait_warn_ms": self.tts.queue_wait_warn_ms,
                "comfort_noise_db": (comfort.db if comfort is not None else None),
                "loudness_normalize": self.tts.normalizer.enabled,
                "loudness_target_db": self.tts.normalizer.target_db,
                # governor caps as flat knob keys (dynamic — walled by env ceilings)
                "tts_chars": self.tts.governor.max_tts_chars,
                "stt_seconds": self.tts.governor.max_stt_seconds,
            })
            # Flatten voice settings to top-level knob keys so the console reads
            # config[knob] uniformly for every knob (sliders + selects + toggles).
            snap.update(vs)
        if self.vad is not None:
            snap["vad_threshold"] = self.vad.threshold
            snap["vad_hangover_ms"] = self.vad.hangover_ms
        return snap

    async def _apply_config(self, params, who, policy=("all", None)):
        """Clamp → apply (agent knobs in-process, RVC knobs mid-stream) →
        capture snapshot → broadcast applied truth. Never raises upward.
        The whole body holds _config_lock so overlapping applies stay FIFO
        and every broadcast reflects the true final state of its apply.

        `policy` is the requester's token-carried voice policy (P4c). The
        wire path (_handle_data) ALWAYS passes it explicitly; the permissive
        default exists only for direct internal/test callers, which carry no
        user token to enforce against."""
        async with self._config_lock:
            applied, adjusted, rejected = knobs.clamp_params(params)

            def reject(name, reason):
                # rejected wins — a knob is never both adjusted and rejected,
                # and a rejected value must not appear to have been applied
                rejected[name] = reason
                adjusted.pop(name, None)
                applied.pop(name, None)

            # Per-model validation resolves against the model this apply RESULTS
            # in: a payload that switches to eleven_v3 AND sets similarity_boost
            # rejects similarity_boost (v3 doesn't support it), never silently.
            effective_model = (applied.get("tts_model", self.tts.tts.model)
                               if self.tts is not None else None)

            rvc_updates = {}
            for name, value in list(applied.items()):
                target = knobs.KNOBS[name]["target"]
                if target == "rvc":
                    if self.rvc is None:
                        reject(name, "no RVC engine (--engine tts)")
                        continue
                    rvc_updates[name] = value
                elif target == "tts":
                    if self.tts is None:
                        reject(name, "no TTS engine (--engine rvc)")
                        continue
                    if name == "tts_model":
                        self.tts.tts.set_model(value)
                        # model change → fresh continuity chain (v3 has no stitching)
                        self.tts.reset_continuity()
                    elif name == "voice":
                        await self._switch_voice(value, reject, policy)
                    elif name == "request_continuity":
                        # stitching is unsupported on some models — same
                        # disable-with-reason contract as the voice settings
                        why = knobs.model_unsupported(name, effective_model)
                        if why:
                            reject(name, f"{why} (model {effective_model})")
                            continue
                        self.tts.request_continuity = value
                    else:
                        why = knobs.model_unsupported(name, effective_model)
                        if why:
                            reject(name, f"{why} (model {effective_model})")
                            continue
                        self.tts.tts.apply_voice_setting(name, value)
                elif target == "governor":
                    # Session cap knob (ticket 2). The governor clamps to the
                    # env-only ceiling (the wall) and reports the same three-way
                    # disposition as every knob: applied, or adjusted when it hit
                    # the wall. clamp_params already ensured value is finite >= 0.
                    if self.tts is None:
                        reject(name, "no governor (--engine rvc)")
                        continue
                    applied_value, adj = self.tts.governor.set_cap(name, value)
                    applied[name] = applied_value
                    if adj is not None:
                        adjusted[name] = adj
                elif name == "prime_hops":
                    self.outgate.prime_samples = knobs.prime_hops_to_samples(value)
                elif name in ("vad_threshold", "vad_hangover_ms"):
                    if self.vad is None:
                        reject(name, "vad disabled (--no-vad)")
                        continue
                    if name == "vad_threshold":
                        self.vad.set_threshold(value)
                    else:
                        self.vad.set_hangover_ms(value)
                elif name in ("min_speech_ms", "queue_wait_warn_ms", "comfort_noise_db",
                              "loudness_normalize", "loudness_target_db"):
                    # tts-only pipeline knobs (endpointer + engine + output bed +
                    # loudness normalizer live only there)
                    if self.tts is None:
                        reject(name, "tts engine only (--engine rvc)")
                        continue
                    if name == "min_speech_ms":
                        self.tts.endpointer.min_speech_ms = value
                    elif name == "queue_wait_warn_ms":
                        self.tts.queue_wait_warn_ms = value
                    elif name == "comfort_noise_db":
                        self.outgate.set_comfort_noise_db(value)
                    elif name == "loudness_normalize":
                        self.tts.normalizer.set_enabled(value)
                    else:
                        self.tts.normalizer.set_target_db(value)
            if rvc_updates:
                try:
                    # Mid-stream JSON settings frame on the open socket (verified
                    # against OpenVoiceChanger backend @ 4cee7ef); if disconnected
                    # the merge into rvc.config makes the next connect carry it
                    live = await self.rvc.send_settings(rvc_updates)
                    if not live:
                        log.info("RVC knobs stored; will apply on next RVC connect")
                except Exception as exc:
                    log.warning("mid-stream settings frame failed: %s", exc)
            if adjusted:
                log.info("clamped out-of-range knobs from %s: %s", who, adjusted)
            if rejected:
                log.warning("rejected knob values from %s: %s", who, rejected)
            if self.capture:
                self.capture.event("config_change", requested=params,
                                   config=self.config_snapshot(),
                                   adjusted=adjusted or None, rejected=rejected or None)
            await self._publish_config(adjusted=adjusted, rejected=rejected)

    async def _switch_voice(self, voice_id, reject, policy=("all", None)):
        """Apply a voice selection (ticket 6). Validates against the account
        list AND the requester's token-carried policy (P4c), loads the NEW
        voice's own default settings so the applied-truth broadcast shows
        what is in effect for it (never stale sliders), and resets request
        continuity so delivery doesn't stitch across voices."""
        match = next((v for v in self.tts.voices if v["voice_id"] == voice_id), None)
        if match is None:
            # A voice cloned — or healed — seconds ago is real at the vendor
            # but absent from this cache, which was listed at startup. Re-list
            # ONCE before rejecting, so "clone it, then speak in it" needs no
            # reconnect (CEO, 12 Aug 2026: the agent must recognize new
            # clones immediately). Failure-silent listing: an empty answer is
            # a transient vendor problem and must not blank the known list.
            fresh = await list_voices(self.tts.tts.session, self.tts.tts.api_key)
            if fresh:
                self.tts.voices = fresh
                log.info("voice list refreshed on cache miss (%d voices)", len(fresh))
                match = next((v for v in self.tts.voices if v["voice_id"] == voice_id), None)
        if match is None or not voice_allowed(policy, match):
            # ONE message for both unknown and disallowed: a rejection that
            # distinguished them would be an existence oracle for other
            # users' clones.
            reject("voice", "unknown voice_id (not available for this session)")
            return
        new_settings = None
        try:
            newvoice = await fetch_voice(self.tts.tts.session, self.tts.tts.api_key, voice_id)
            new_settings = voice_settings_from(newvoice)
        except Exception as exc:
            log.warning("could not load settings for voice %s (%s) — keeping current",
                        voice_id, exc)
        self.tts.tts.set_voice(voice_id, voice_settings=new_settings)
        self.tts.reset_continuity()
        log.info("voice → %r (%s)", match.get("name"), voice_id)

    async def _refresh_voices(self, who):
        """Re-list the account's voices (free GET) and re-broadcast the config
        so the selector picks up voices added since startup."""
        self.tts.voices = await list_voices(self.tts.tts.session, self.tts.tts.api_key)
        log.info("voice list refreshed to %d voices (requested by %s)",
                 len(self.tts.voices), who)
        await self._publish_config()

    def _room_voice_policy(self):
        """The policy governing the shared broadcast (P4c). The broadcast is
        room-wide, and the product runs one user per room — but the rule
        must hold even when it isn't: every restricted ('own') participant
        narrows the list, and multiple restricted participants INTERSECT
        (CodeRabbit, PR 93 — returning the first 'own' policy would put
        user A's clone ids in a broadcast user B can read). An ops probe
        ('all') never widens; an empty room keeps 'all' because nothing
        user-facing renders from it and the connect handler re-broadcasts
        the moment someone joins."""
        participants = getattr(self.room, "remote_participants", None) or {}
        own_sets = []
        for p in participants.values():
            if p.identity.startswith("echo-"):
                continue
            policy = voice_policy_from_metadata(getattr(p, "metadata", None))
            if policy[0] == "own":
                own_sets.append(policy[1])
        if not own_sets:
            return ("all", None)
        ids = own_sets[0]
        for s in own_sets[1:]:
            ids = ids & s
        return ("own", ids)

    async def _publish_config(self, adjusted=None, rejected=None):
        """Broadcast the applied config + registry metadata (defaults/ranges)
        so the UI renders entirely from agent truth."""
        if self.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            return
        # Engine-keyed: a tts agent broadcasts only tts knobs, an rvc agent the
        # old set. The console renders entirely from this — no hardcoded engine
        # assumptions in the frontend. `metadata` carries per-knob kind, group,
        # timing and per-model support so the UI needs nothing baked in. The
        # voice knob's choices are the account's live voices, injected here —
        # filtered to the room's voice policy (P4c): the dropdown a user sees
        # IS this list, so isolation must hold here, not just at the switch.
        voice_choices = None
        if self.tts is not None:
            room_policy = self._room_voice_policy()
            voice_choices = [{"id": v["voice_id"], "name": v["name"],
                              "category": v.get("category"),
                              # the vendor's own sample clip — the studio's
                              # preview button for system voices (clones
                              # preview from OUR vaulted sample instead)
                              "preview_url": v.get("preview_url")}
                             for v in self.tts.voices
                             if voice_allowed(room_policy, v)]
        spend = self.tts.governor.snapshot() if self.tts is not None else None
        payload = {
            "type": "agent_config",
            "engine": self.engine,
            "app_version": APP_VERSION,
            "config": self.config_snapshot(),
            "defaults": knobs.defaults(self.engine),
            "ranges": knobs.ranges(self.engine),
            "metadata": knobs.metadata(self.engine, voice_choices=voice_choices,
                                       spend=spend),
            # Governor caps are console knobs now (ticket 2), walled by env-only
            # ceilings. `spend` carries live usage + the cap + the ceiling so the
            # console renders the cap sliders (max = ceiling) and the usage line.
            "spend": spend,
        }
        if adjusted:
            payload["adjusted"] = adjusted
        if rejected:
            payload["rejected"] = rejected
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload), reliable=True
            )
        except Exception as exc:
            log.error("failed to publish agent_config: %s", exc)

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
            self._spawn(self._apply_mode_sync_fallback())
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
                "engine": self.engine,
                "rvc_ws_url": None if self.rvc is None else self.rvc_url,
                "sample_rate": SAMPLE_RATE,
                "hop": HOP, "ctx": CTX, "xfade": XFADE, "sola": SOLA,
                "prime_samples": PRIME_SAMPLES,
                "vad": None if self.vad is None else {
                    "active": self.vad.active,
                    "threshold": self.vad.threshold,
                    "hangover_ms": self.vad.hangover_ms,
                    "hangover_hops": self.vad.hangover_hops,
                },
                "config": self.config_snapshot(),
            }).start()
            log.info("capture ON → %s", self.capture.session_dir)
        try:
            async for event in stream:
                self.frames_in += 1
                frame = event.frame
                if self.capture:
                    self.capture.add_input(bytes(frame.data))
                if self.mode == "convert":
                    if self.tts is not None:
                        await self._tts_frame(frame)
                    else:
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

        # Input side: window assembly + VAD gate + send with backpressure.
        # GATING NEVER TOUCHES THE ASSEMBLER: it keeps accumulating through
        # gated periods, so the first window after gate-open carries real
        # acoustic context. The seq assert below enforces that accounting.
        for seq, window in self.assembler.feed(pcm):
            # Invariant, checked explicitly (a bare assert would die silently in
            # the asyncio task and vanish under -O): the assembler numbers every
            # hop consecutively whether or not it gets sent
            if seq != self._last_hop_seq + 1:
                log.error("context accounting broken: hop seq %d after %d — "
                          "continuing; VAD gating may misalign until re-entry",
                          seq, self._last_hop_seq)
            self._last_hop_seq = seq

            if self.capture:  # jitter-buffer depth, sampled every hop
                self.capture.event("buffer_depth", seq=seq,
                                   depth=self.stitcher.available,
                                   in_flight=self.rvc.in_flight)

            if self.vad is not None:
                was_open = self.vad.gate_open
                send = self.vad.decide_hop(window[-HOP:])
                if not self.vad.active and not self._vad_fail_published:
                    # fail-open just tripped — report once over the data channel
                    self._vad_fail_published = True
                    self._spawn(self._publish_mode())
                elif self.vad.gate_open != was_open:
                    state = "open" if self.vad.gate_open else "closed"
                    log.info("VAD gate %s (prob %.2f)", state, self.vad.last_prob or 0.0)
                    if self.capture:
                        self.capture.event("vad_gate", state=state, seq=seq,
                                           prob=round(self.vad.last_prob or 0.0, 3))
                if not send:
                    # Gated: nothing enqueued to the websocket (idle GPU is the
                    # point) and NOT a backpressure drop
                    self.windows_gated += 1
                    continue

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
        # OutputGate wraps the Phase 1 priming/underrun behavior and adds the
        # VAD edges: fade-out drain at gate close, silence while closed,
        # re-prime + fade-in at gate open. gate_open=True (no VAD / fail-open)
        # reproduces the old path exactly.
        gate_open = self.vad is None or not self.vad.active or self.vad.gate_open
        was_primed = self.outgate.primed
        underruns_before = self.stitcher.underrun_events
        samples = self.outgate.read_frame(n, gate_open)
        if self.outgate.primed and not was_primed:
            log.info("jitter buffer primed (%d samples)", self.stitcher.available + n)
        if self.capture and self.stitcher.underrun_events > underruns_before:
            self.capture.event("underrun", samples=n)
        if self.outgate.drained:
            # Tail played out after gate close — any window still in flight
            # belongs to the closed period; discard it as stale on arrival
            self._min_valid_seq = self.assembler.seq + 1
            if self.capture:
                self.capture.event("vad_drained")

        out = rtc.AudioFrame.create(SAMPLE_RATE, NUM_CHANNELS, n)
        np.frombuffer(out.data, dtype=np.int16)[:] = (
            np.clip(samples, -1.0, 1.0) * 32767.0
        ).astype(np.int16)
        if self.capture:
            self.capture.add_output(bytes(out.data))
        await self.source.capture_frame(out)

    # ── The TTS engine's frame path (SPIKE) ──────────────────────────

    async def _tts_frame(self, frame):
        """Same shape as _convert_frame: assemble hops in, publish frames out.

        The input side runs the identical assembler + VAD decision the RVC path
        uses, so both engines endpoint on the same gate and the Phase 3/4 VAD
        knobs keep their meaning. The difference is only what the hop is handed
        to: RVC gets a window over the websocket, the endpointer gets the hop.
        """
        n = frame.samples_per_channel
        pcm = np.frombuffer(frame.data, dtype=np.int16).astype(np.float32) / 32768.0

        if self.vad is None or not self.vad.active:
            if self._tts_vad_fallback_fired:
                # Already handled; the mode flip is in flight. Without this the
                # branch re-runs for EVERY 10 ms frame until the flip lands —
                # 100 log lines and 100 spawned tasks per second.
                if self.capture:
                    self.capture.add_output(bytes(frame.data))
                await self.source.capture_frame(frame)
                return
            self._tts_vad_fallback_fired = True
            # The VAD is not optional here — it IS the endpointer. Without it
            # the gate never closes, no utterance is ever emitted, and the
            # buffer just grows to the forced-cut bound burning STT budget on
            # 30-second slabs. Falling back keeps the room alive and spends
            # nothing, which is the fail-open outcome that makes sense in
            # tts mode.
            log.error("VAD unavailable in tts mode — falling back to passthrough "
                      "(the gate is the endpointer; there is no engine without it)")
            self._spawn(self._apply_mode("passthrough", "vad_required_for_tts"))
            if self.capture:
                self.capture.add_output(bytes(frame.data))
            await self.source.capture_frame(frame)
            return

        for seq, window in self.assembler.feed(pcm):
            hop = window[-HOP:]
            was_open = self.vad.gate_open
            gate_open = self.vad.decide_hop(hop)
            # is_speech distinguishes a real speech hop from a hangover hop, so
            # the endpointer can subtract the hangover when timing tail_latency
            is_speech = (self.vad.last_prob is not None
                         and self.vad.last_prob >= self.vad.threshold)
            if self.vad.gate_open != was_open:
                state = "open" if self.vad.gate_open else "closed"
                log.info("VAD gate %s (prob %.2f)", state, self.vad.last_prob or 0.0)
                if self.capture:
                    self.capture.event("vad_gate", state=state, seq=seq,
                                       prob=round(self.vad.last_prob or 0.0, 3))
            if not gate_open:
                # Same meaning as the RVC path: a hop the gate withheld. The
                # tts stats line has always printed this counter; without this
                # increment it printed a permanent 0, which is worse than not
                # printing it at all.
                self.windows_gated += 1
            await self.tts.feed_hop(hop, gate_open, is_speech)

        # Output side: 1 frame in → 1 frame out, same pacing contract as the
        # RVC path, same OutputGate, same AudioSource.
        underruns_before = self.stitcher.underrun_events
        was_primed = self.outgate.primed
        samples = self.tts.read_frame(n)
        if self.outgate.primed and not was_primed:
            log.info("tts jitter buffer primed")
        if self.capture and self.stitcher.underrun_events > underruns_before:
            self.capture.event("underrun", samples=n)
        if self.outgate.drained and self.capture:
            self.capture.event("tts_drained")

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
            if self.tts is not None:
                log.info(
                    "stats: mode=%s frames in=%d (+%d) out=%d (+%d) | gated=%d "
                    "vad=%s | underruns=%d (%d samples) | %s",
                    self.mode, cur[0], cur[0] - prev[0], cur[1], cur[1] - prev[1],
                    self.windows_gated,
                    "off" if self.vad is None
                    else ("open" if self.vad.gate_open else "closed")
                    if self.vad.active else "FAILED-OPEN",
                    self.stitcher.underrun_events, self.stitcher.underrun_samples,
                    self.tts.stats_line(),
                )
                prev = cur
                continue
            p50, p95 = self.rvc.turnaround_ms()
            log.info(
                "stats: mode=%s frames in=%d (+%d) out=%d (+%d) | windows sent=%d recv=%d "
                "dropped=%d stale=%d gated=%d vad=%s | underruns=%d (%d samples) | "
                "turnaround p50/p95=%s/%s ms | buffer=%d samples (%.2f hops)",
                self.mode,
                cur[0], cur[0] - prev[0], cur[1], cur[1] - prev[1],
                self.rvc.windows_sent, self.rvc.windows_received,
                self.windows_dropped, self.windows_stale, self.windows_gated,
                "off" if self.vad is None
                else ("open" if self.vad.gate_open else "closed") if self.vad.active
                else "FAILED-OPEN",
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
        await self._publish_config()

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
        if self.tts is not None:
            await self.tts.aclose()
        if self.rvc is not None:
            await self.rvc.close()
        await self.room.disconnect()


async def main():
    parser = argparse.ArgumentParser(description="LuminaStream RVC convert agent")
    parser.add_argument("--mode", choices=MODES, default="passthrough",
                        help="startup mode (default: passthrough)")
    parser.add_argument("--room", default=os.environ.get("LIVEKIT_ROOM", DEFAULT_ROOM),
                        metavar="NAME",
                        help="LiveKit room to join (env: LIVEKIT_ROOM, default: "
                             f"{DEFAULT_ROOM!r}). A first-class flag so two agent "
                             "processes with different --room serve two rooms "
                             "concurrently — the manual two-session test.")
    parser.add_argument("--identity", default=DEFAULT_IDENTITY)
    parser.add_argument("--rvc-url", default=os.environ.get("RVC_WS_URL", DEFAULT_RVC_WS_URL))
    parser.add_argument("--capture-dir", default=None, metavar="PATH",
                        help="write per-session diagnostic captures (WAVs + meta.jsonl) "
                             "under PATH; capture is fully disabled when absent")
    parser.add_argument("--no-vad", action="store_true",
                        help="disable the Silero VAD gate (default: VAD on)")
    parser.add_argument("--vad-threshold", type=float, default=None,
                        help=f"speech probability threshold (default {DEFAULT_THRESHOLD}, "
                             "silero's own default; tts mode also reads tts_profile.json — "
                             "precedence CLI > profile > default)")
    parser.add_argument("--vad-hangover-ms", type=float, default=None,
                        help=f"keep the gate open this long after the last speech "
                             f"(default {DEFAULT_HANGOVER_MS} ms; rounded UP to whole hops)")
    parser.add_argument("--engine", choices=ENGINES, default="tts",
                        help="tts (DEFAULT since 28 Jul 2026: STT→TTS through the "
                             "cloned voice) or rvc (the parked baseline; still "
                             "fully supported, nothing was removed)")
    parser.add_argument("--tts-model", default=None,
                        help=f"--engine tts: ElevenLabs model_id (default "
                             f"{DEFAULT_TTS_MODEL}; also eleven_multilingual_v2, "
                             "eleven_v3). Overrides tts_profile.json's model.")
    parser.add_argument("--drill-script", default=None, metavar="PATH",
                        help="--engine tts: fixed drill script, one line per "
                             "utterance; transcripts are scored (WER) against it")
    parser.add_argument("--report", default=None, metavar="PATH",
                        help="--engine tts: write the per-utterance metrics + "
                             "latency table as JSON on shutdown")
    parser.add_argument("--tts-hangover-ms", type=float, default=None, metavar="MS",
                        help="--engine tts: override --vad-hangover-ms in tts mode. "
                             "The hangover sits directly in tail_latency (the gate "
                             "must close before the transcript is committed), so it "
                             "is worth tuning separately from the RVC noise gate")
    parser.add_argument("--run-seconds", type=float, default=None, metavar="N",
                        help="exit cleanly after N seconds (scripted E2E runs); "
                             "default is to run until SIGINT/SIGTERM")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )
    if args.engine == "tts" and args.no_vad:
        raise SystemExit(
            "--engine tts is incompatible with --no-vad: in tts mode the VAD gate "
            "IS the utterance endpointer. Without it the gate never closes, no "
            "utterance is ever emitted, and the buffer grows to the forced-cut "
            "bound — burning STT budget on 30-second slabs."
        )

    # Room is a first-class flag/env (LIVEKIT_ROOM). Logged prominently at the
    # very top so that when two agents run side by side (the two-session test)
    # which-process-serves-which-room is unambiguous from the first line.
    log.info("══════ convert agent · engine=%s · ROOM=%r · identity=%r ══════",
             args.engine, args.room, args.identity)

    url, key, secret = load_credentials()
    token = mint_token(key, secret, args.room, args.identity)

    # Config-as-code precedence (tts): CLI/env > committed profile > registry
    # defaults. The pipeline knobs (VAD pair) resolve here — the clone's own
    # voice settings only touch the voice knobs, which build_tts_engine resolves
    # after fetching the voice. rvc mode keeps its exact prior behavior.
    profile_flat = cli_overrides = {}
    if args.engine == "tts":
        profile_flat, prof_adj, prof_rej = knobs.clamp_params(
            knobs.flatten_profile(load_profile(PROFILE_PATH)))
        if prof_adj:
            log.warning("tts_profile.json clamped into range: %s", prof_adj)
        if prof_rej:
            log.warning("tts_profile.json rejected (ignored): %s", prof_rej)
        cli_overrides, _cadj, cli_rej = knobs.clamp_params(_tts_cli_overrides(args))
        if cli_rej:
            log.warning("tts CLI overrides rejected: %s", cli_rej)
        resolved_pipe = knobs.resolve_precedence(
            knobs.defaults("tts"), profile_flat, cli_overrides)
        vad_threshold = resolved_pipe["vad_threshold"]
        vad_hangover_ms = resolved_pipe["vad_hangover_ms"]
    else:
        vad_threshold = (args.vad_threshold if args.vad_threshold is not None
                         else DEFAULT_THRESHOLD)
        vad_hangover_ms = (args.vad_hangover_ms if args.vad_hangover_ms is not None
                           else DEFAULT_HANGOVER_MS)

    # VAD loads BEFORE the room join, same philosophy as the RVC warmup.
    # Load failure ⇒ fail-open (ungated), the stream still runs.
    vad = None
    if not args.no_vad:
        vad = VadGate(threshold=vad_threshold,
                      hangover_ms=vad_hangover_ms).load()
        if vad.active:
            log.info("VAD on: threshold=%.2f hangover=%dms (%d hops of %dms)",
                     vad.threshold, vad.hangover_ms, vad.hangover_hops,
                     HOP * 1000 // SAMPLE_RATE)
        else:
            log.warning("VAD failed to load (%s) — running ungated", vad.fail_reason)
    else:
        log.info("VAD off (--no-vad)")

    http = tts_engine = None
    if args.engine == "tts":
        http, tts_engine = await build_tts_engine(args, profile_flat, cli_overrides)

    agent = ConvertAgent(args.room, args.identity, args.rvc_url, args.mode,
                         capture_dir=args.capture_dir, vad=vad,
                         engine=args.engine, tts_engine=tts_engine)

    if args.engine == "rvc":
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
    elif args.mode == "convert":
        agent._set_mode("convert")

    stats_task = asyncio.ensure_future(agent._stats_loop())
    try:
        await agent.start(url, token)
        await wait_for_stop(args.run_seconds)
    finally:
        stats_task.cancel()
        # The run ends on SIGINT, so teardown happens inside a cancelled task.
        # The measurements are the whole point of the run — never lose them to
        # a shutdown error.
        try:
            await agent.aclose()
        except Exception:
            log.exception("error during shutdown — reporting anyway")
        if tts_engine is not None:
            write_spike_report(tts_engine, args.report)
        if http is not None:
            await http.close()


async def wait_for_stop(run_seconds=None):
    """Block until SIGINT/SIGTERM, or until run_seconds elapses.

    The default `asyncio.Event().wait()` relies on the interpreter's default
    SIGINT handling, which does not reliably interrupt this process: the
    LiveKit Rust FFI runs its own threads and an orphaned agent (parent shell
    gone) was observed ignoring SIGINT entirely, stranding the run with its
    measurements unwritten. Installing explicit loop signal handlers makes
    shutdown deterministic, and --run-seconds removes signals from scripted
    E2E runs altogether.
    """
    loop = asyncio.get_event_loop()
    stop = asyncio.Event()
    for signame in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(signal, signame), stop.set)
        except (NotImplementedError, AttributeError, RuntimeError):
            pass  # not available on this platform — fall back to default handling
    if run_seconds is None:
        await stop.wait()
        log.info("stop signal received — shutting down")
        return
    try:
        await asyncio.wait_for(stop.wait(), run_seconds)
        log.info("stop signal received — shutting down")
    except asyncio.TimeoutError:
        log.info("--run-seconds %.0f elapsed — shutting down", run_seconds)


def _tts_cli_overrides(args):
    """Explicitly-set CLI flags → flat {knob: value}, the operator's top-
    priority layer (wins over the committed profile). SPIKE_TTS_* env overrides
    for voice settings are applied separately (resolve_voice_settings), after
    the profile, so they also win — that is the "CLI/env > profile" rule."""
    cli = {}
    if args.tts_model is not None:
        cli["tts_model"] = args.tts_model
    if args.vad_threshold is not None:
        cli["vad_threshold"] = args.vad_threshold
    # --tts-hangover-ms is the tts-mode alias for --vad-hangover-ms
    if args.tts_hangover_ms is not None:
        cli["vad_hangover_ms"] = args.tts_hangover_ms
    elif args.vad_hangover_ms is not None:
        cli["vad_hangover_ms"] = args.vad_hangover_ms
    return cli


async def build_tts_engine(args, profile_flat, cli_overrides):
    """Construct the SPIKE engine: governor first, then the vendor clients.

    Returns (http_session, TtsEngine). The governor is built before either
    client exists — the caps have to be in force before anything can spend.
    `profile_flat`/`cli_overrides` are the already-clamped config-as-code layers
    resolved against the clone's own settings once the voice is fetched.
    """
    from spend_governor import SpendGovernor  # local: rvc mode never needs these

    governor = SpendGovernor()
    governor.log_startup()

    # The keyring (CEO architecture, 10 Aug 2026): ELEVENLABS_API_KEY keeps
    # its name, its VALUE is the ordered pool — first key preferred, next
    # keys tried when a candidate fails its gates. A bare single key is a
    # pool of one, byte-identical to the old behavior.
    pool = vendor_keys.parse_pool(os.environ.get("ELEVENLABS_API_KEY"))
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID")
    # An empty pool reuses check_credentials so the operator reads the exact
    # existing "missing from secrets.env" sentence.
    check_credentials(pool[0].api_key if pool else None, voice_id)

    drill_lines = []
    if args.drill_script:
        drill_lines = wer.load_script(args.drill_script)
        log.info("drill script: %d lines from %s", len(drill_lines), args.drill_script)

    # keepalive_timeout well above the ping interval: an idle pooled connection
    # reaped between utterances makes the next one pay a full reconnect, which
    # was the entire 1043 ms vs 323 ms gap on the first utterance of a run.
    http = aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(keepalive_timeout=120, limit=8))
    try:
        return await _preflight_pool(args, http, pool, voice_id,
                                     governor, drill_lines,
                                     profile_flat, cli_overrides)
    except BaseException:
        # Close the session a failed preflight opened. Otherwise aiohttp prints
        # an "Unclosed client session" traceback on GC, burying the single
        # sentence the operator actually needs to read.
        await http.close()
        raise


def resolve_startup_voice(configured, voices):
    """The startup voice THIS account can actually serve.

    The configured voice (profile pin or ELEVENLABS_VOICE_ID) may be a clone
    living on a different account — the trap that would make a healthy
    backup key look dead at fetch_voice. If the configured id is on this
    account's list, use it; else fall back to the account's first premade,
    LOUDLY (a last-resort safety net — the Worker's voice healer keeps
    product clones on the active account, so this firing means a
    dashboard-era or foreign voice is pinned); no premade either → this
    candidate is unusable.
    """
    ids = {v["voice_id"] for v in voices}
    if configured and configured in ids:
        return configured
    for v in voices:
        if v.get("category") == "premade":
            log.warning(
                "startup voice %r is not on this account — falling back to "
                "premade %r (%s). If a pinned clone was expected, re-clone it "
                "through the studio so the healer owns its sample.",
                configured, v.get("name"), v["voice_id"])
            return v["voice_id"]
    raise PreflightError(
        "This account lists no usable startup voice (configured voice absent "
        "and no premade voices visible).")


async def _preflight_pool(args, http, pool, voice_id, governor,
                          drill_lines, profile_flat, cli_overrides):
    """Try each key in pool order; the first that passes every gate wins.

    Order IS preference (the operator edits the list); a candidate that
    fails ANY gate — listing, voice resolution, STT, the 1-char warmup
    synthesis — is recorded and the next is tried. All dead → one
    PreflightError naming every account's reason, keys only ever
    fingerprint/masked.
    """
    configured_voice = profile_flat.get("voice") or voice_id
    failures = []
    for cand in pool:
        try:
            voices = await list_voices_strict(http, cand.api_key)
            startup_voice = resolve_startup_voice(configured_voice, voices)
            result = await _preflight_and_build(
                args, http, cand.api_key, startup_voice, voices,
                governor, drill_lines, profile_flat, cli_overrides)
            log.info("ELEVENLABS ACCOUNT %s ACTIVE (key %s)",
                     cand.fingerprint, vendor_keys.mask(cand.api_key))
            return result
        except PreflightError as exc:
            failures.append(f"account {cand.fingerprint} "
                            f"(key {vendor_keys.mask(cand.api_key)}): {exc}")
            log.warning("ElevenLabs account %s failed preflight — trying next "
                        "key in the pool. Reason: %s", cand.fingerprint, exc)
    raise PreflightError(
        "All configured ElevenLabs accounts failed preflight: "
        + " | ".join(failures))


async def _preflight_and_build(args, http, api_key, startup_voice, voices,
                               governor, drill_lines, profile_flat, cli_overrides):
    # The startup voice and the account listing arrive PRE-RESOLVED by the
    # pool loop (one strict GET per candidate, one source of truth); the
    # gate chain below is byte-identical to the single-key era.
    voice = await fetch_voice(http, api_key, startup_voice)

    # Precedence, resolved now that the clone's own settings are in hand:
    #   registry defaults → refined by the clone's settings → committed profile
    #   → CLI/env overrides. The clone is the declared quality reference, so it
    #   is the baseline the profile and overrides deviate from.
    base = knobs.defaults("tts")
    for field, value in voice_settings_from(voice).items():
        if field in base:               # clone refines the voice-setting knobs
            base[field] = value
    resolved = knobs.resolve_precedence(base, profile_flat, cli_overrides)
    model = resolved["tts_model"]
    voice_settings = {k: resolved[k] for k in knobs.PROFILE_VOICE_KEYS}
    # SPIKE_TTS_* env overrides are the final (highest) voice-setting layer
    voice_settings = resolve_voice_settings(voice_settings)
    log.info("resolved tts config (CLI/env > profile > clone > registry): "
             "voice=%r model=%s voice_settings=%s prime_hops=%.2f min_speech_ms=%.0f "
             "queue_warn_ms=%.0f comfort_noise_db=%.0f continuity=%s "
             "loudness=%s@%.1fdBFS",
             voice.get("name"), model, voice_settings, resolved["prime_hops"],
             resolved["min_speech_ms"], resolved["queue_wait_warn_ms"],
             resolved["comfort_noise_db"], resolved.get("request_continuity", True),
             "on" if resolved["loudness_normalize"] else "off",
             resolved["loudness_target_db"])

    stt = SttClient(http, api_key)
    tts = TtsClient(http, api_key, startup_voice, model=model,
                    voice_settings=voice_settings)
    queue = PcmQueue()
    engine = TtsEngine(
        stt=stt, tts=tts, governor=governor,
        endpointer=UtteranceEndpointer(min_speech_ms=resolved["min_speech_ms"]),
        queue=queue,
        outgate=OutputGate(queue, knobs.prime_hops_to_samples(resolved["prime_hops"]),
                           comfort_noise_db=resolved["comfort_noise_db"]),
        drill_lines=drill_lines,
    )
    engine.queue_wait_warn_ms = resolved["queue_wait_warn_ms"]
    engine.request_continuity = bool(resolved.get("request_continuity", True))
    engine.normalizer.set_enabled(resolved["loudness_normalize"])
    engine.normalizer.set_target_db(resolved["loudness_target_db"])
    # The pool loop's strict listing, reused — no second GET, no drift.
    engine.voices = voices
    # Warm BOTH vendors before the room join — the STT handshake (~900 ms) and
    # the TTS cold-voice penalty (993 ms vs ~376 ms steady) would otherwise land
    # inside the first utterance's tail. Same philosophy as the RVC warmup.
    try:
        await stt.connect()
        log.info("STT READY (%s)", stt.model)
    except Exception as exc:
        raise PreflightError(
            f"Could not open the ElevenLabs realtime STT session ({exc!r}). The "
            f"key and voice were accepted, so this is the realtime endpoint — "
            f"check outbound WebSocket access to {stt.url.split('?')[0]}.")
    try:
        await tts.warmup(governor)
    except PreflightError:
        # A candidate that dies at the spend gate must not leak its live STT
        # socket into the next candidate's attempt on the shared session.
        try:
            await stt.close()
        except Exception:
            pass
        raise
    log.info("PREFLIGHT OK — engine=tts model=%s stt=%s voice=%r (%d account voices)",
             model, stt.model, voice.get("name"), len(engine.voices))
    return http, engine.start()


def write_spike_report(engine, path):
    """Latency table + per-utterance records + final spend, to stdout and JSON."""
    table = engine.latency_table()
    log.info("── SPIKE RESULT ──")
    log.info("%s", engine.governor.summary_line())
    for model, stats in table.items():
        log.info("%s: n=%d tail_latency p50/p95 = %s/%s ms | ttfb p50 %s | stt p50 %s",
                 model, stats["n"],
                 (stats["tail_latency_ms"] or {}).get("p50"),
                 (stats["tail_latency_ms"] or {}).get("p95"),
                 (stats["tts_ttfb_ms"] or {}).get("p50"),
                 (stats["stt_ms"] or {}).get("p50"))
    scored = [r.get("wer_detail") for r in engine.records if r.get("wer_detail")]
    corpus = wer.aggregate(scored)
    if corpus:
        log.info("transcript fidelity: corpus WER %.4f over %d utterances",
                 corpus["corpus_wer"], corpus["utterances"])
    if not path:
        return
    payload = {
        "latency_table": table,
        "wer": corpus,
        "spend": engine.governor.snapshot(),
        "utterances": engine.records,
        "skipped": engine.skipped,
        "max_queue_depth": engine.max_queue_depth,
    }
    Path(path).write_text(json.dumps(payload, indent=2))
    log.info("report written → %s", path)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("stopped by user")
    except PreflightError as exc:
        # A config problem the operator can fix. Print the sentence and exit —
        # a traceback here would bury the one line that matters.
        log.error("PREFLIGHT FAILED — %s", exc)
        raise SystemExit(2)
