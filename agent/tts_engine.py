"""The STT→TTS engine — the spike's second engine, behind --engine tts.

Shape of one utterance, and where every measured number comes from:

  VAD gate closes
    └─ UtteranceEndpointer emits the buffered speech (hangover included)
        └─ governor.reserve_stt(duration)      ── refuse ⇒ skip utterance WHOLE
            └─ SttClient.transcribe()          ── one commit, one transcript
                └─ governor.reserve_tts(chars) ── refuse ⇒ skip utterance WHOLE
                    └─ TtsClient.stream()      ── first chunk stops the clock
                        └─ PcmQueue → OutputGate → AudioSource (all unchanged)

tail_latency is the headline: from the last SPEECH sample (gate-close minus
the hangover the endpointer actually applied) to the first synthesized sample
ENQUEUED on the jitter buffer. Enqueued, not audible — the priming depth that
follows is an existing, separately-tunable property of the output path
(prime_hops), and folding it in here would measure the jitter buffer twice.

Utterances are processed strictly one at a time by a single worker. Overlapping
them would interleave two syntheses into one FIFO and produce audio in the
wrong order; a queue depth >1 is reported instead, because "the speaker got
ahead of the pipeline" is a real finding about the latency budget.

FAIL-OPEN, everywhere: a governor refusal, an STT error, an empty transcript
or a TTS error drops THAT utterance with a logged reason and a data-channel
notice. The worker survives, the room stays connected, the next utterance is
processed normally. Nothing here can take the stream down.
"""

import asyncio
import logging
import time

from elevenlabs_client import SttError, TtsError
from spend_governor import GovernorRefusal
from wer import best_match

log = logging.getLogger("tts-engine")

QUEUE_WARN_DEPTH = 2
# Must stay UNDER the connection pool's keepalive_timeout, or the ping always
# arrives after the connection was already reaped and warms nothing. Measured:
# a 15 s idle gap cost the next synthesis ~700 ms of reconnect.
KEEPALIVE_INTERVAL_S = 10


class TtsEngine:
    """Owns the utterance lifecycle, the metrics, and the TTS-side output buffer.

    The agent hands it hops on the input side and pulls frames on the output
    side; everything between is this class's problem.
    """

    def __init__(self, stt, tts, governor, endpointer, queue, outgate,
                 drill_lines=None, on_event=None, on_notice=None):
        self.stt = stt
        self.tts = tts
        self.governor = governor
        self.endpointer = endpointer
        self.queue = queue
        self.outgate = outgate
        self.drill_lines = drill_lines or []
        self._on_event = on_event      # capture/meta.jsonl sink
        self._on_notice = on_notice    # data-channel sink
        self._work = asyncio.Queue()
        self._worker_task = None
        self._keepalive_task = None
        self._synth_in_flight = False
        self.records = []              # one dict per completed utterance
        self.skipped = 0               # dropped for any reason
        self.max_queue_depth = 0
        self.hop_seconds = endpointer.hop / endpointer.sr
        self._utt_streaming = False    # a stream is open for the current utterance
        self._utt_refusal = None       # governor refusal that ended it early
        self._utt_stt_reserved = 0.0   # STT seconds already metered for it

    # ── lifecycle ────────────────────────────────────────────────────

    def start(self):
        self._worker_task = asyncio.ensure_future(self._worker())
        self._keepalive_task = asyncio.ensure_future(self._keepalive())
        return self

    async def _keepalive(self):
        """Keep the TTS connection pooled through conversational silences.

        Speech is bursty: a speaker can easily go a minute without talking, and
        the idle connection is reaped in that time so the next utterance pays a
        reconnect it should not. Pings only while nothing is in flight, and the
        ping itself is a free GET.
        """
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL_S)
            if not self._synth_in_flight:
                await self.tts.ping()

    async def aclose(self):
        if self._keepalive_task is not None:
            self._keepalive_task.cancel()
            self._keepalive_task = None
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, Exception):
                pass
            self._worker_task = None

    def event(self, kind, **fields):
        if self._on_event is not None:
            self._on_event(kind, **fields)

    def notice(self, payload):
        if self._on_notice is not None:
            self._on_notice(payload)

    # ── input side ───────────────────────────────────────────────────

    async def feed_hop(self, hop_pcm, gate_open, is_speech):
        """Called once per hop from the frame loop.

        Audio is streamed to STT as it arrives (see SttClient's streaming
        section). This awaits a websocket send, exactly as the RVC path already
        awaits send_window from its frame loop.

        SPEND, and why per-hop metering is the right shape here: streaming
        means audio is billed as it goes out, so the reservation has to happen
        BEFORE each hop leaves rather than once at gate-close. Every hop is
        therefore reserved before it is sent — the cap can never be exceeded.
        If a hop cannot be afforded, streaming stops immediately and the whole
        utterance is abandoned: no commit, no transcript, no synthesis, no
        output. That still satisfies the rule the addendum actually cares
        about — nothing half-spoken is ever produced — while keeping the hard
        ceiling exact.
        """
        if gate_open:
            if not self._utt_streaming:
                self._utt_streaming = True
                self._utt_refusal = None
                self._utt_stt_reserved = 0.0
                await self.stt.begin_utterance()
            if self._utt_refusal is None:
                try:
                    self.governor.reserve_stt(self.hop_seconds)
                    self._utt_stt_reserved += self.hop_seconds
                    await self.stt.push(hop_pcm)
                except GovernorRefusal as refusal:
                    # One refusal per utterance: streaming stops here and the
                    # utterance is dropped whole when the endpointer emits it.
                    self._utt_refusal = refusal

        utt = self.endpointer.feed_hop(hop_pcm, gate_open, is_speech)
        if utt is None:
            return

        # Commit from the frame path, the instant the gate closes — waiting for
        # the worker to dequeue would put its scheduling delay in the tail.
        utt.governor_refusal = self._utt_refusal
        utt.stt_reserved_s = self._utt_stt_reserved
        utt.committed = False
        if self._utt_refusal is None:
            utt.committed = await self.stt.commit()
            utt.t_commit = time.monotonic()
            if not utt.committed:
                self.stt.fallbacks += 1
        self._utt_streaming = False

        self._work.put_nowait(utt)
        depth = self._work.qsize()
        self.max_queue_depth = max(self.max_queue_depth, depth)
        if depth >= QUEUE_WARN_DEPTH:
            log.warning("utterance queue depth %d — the speaker is ahead of the "
                        "pipeline (latency budget exceeded, not an error)", depth)
        self.event("utterance_end", **utt.summary(), queue_depth=depth,
                   streamed=utt.committed)

    # ── output side ──────────────────────────────────────────────────

    def read_frame(self, n):
        """Exactly n samples for the publisher. Reuses OutputGate untouched.

        gate_open is simply "synthesis is still arriving". When it goes false
        OutputGate plays out what is buffered and fades the final partial frame
        to zero — the same intentional-drain path Phase 3 built for the VAD
        gate, doing the same job at the end of an utterance.
        """
        if not self._synth_in_flight and self.queue.available:
            # All the audio there will ever be for this utterance is already
            # here; if it is thinner than the priming depth, prime anyway or it
            # would sit here forever and leak into the next utterance.
            self.outgate.force_prime()
        return self.outgate.read_frame(n, self._synth_in_flight)

    @property
    def speaking(self):
        return self._synth_in_flight or bool(self.queue.available)

    # ── the worker ───────────────────────────────────────────────────

    async def _worker(self):
        while True:
            utt = await self._work.get()
            try:
                await self._process(utt)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Belt and braces: _process already catches everything it
                # expects. An unexpected error must still not kill the worker.
                self.skipped += 1
                log.exception("utterance %d failed unexpectedly — dropped", utt.index)

    def _drop(self, utt, reason, detail, notice_extra=None):
        self.skipped += 1
        # A dropped utterance must be visible in the LOG, not only in the
        # capture file and on the data channel: a live session showed
        # skipped=1 in the stats with nothing in the log explaining it, which
        # is exactly the "is it broken?" ambiguity the governor marker exists
        # to avoid. Governor refusals additionally log their own ERROR marker.
        log.warning("utterance %d dropped (%s): %s", utt.index, reason, detail)
        self.event("utterance_dropped", index=utt.index, reason=reason,
                   detail=detail, **(notice_extra or {}))
        payload = {"type": "tts_utterance_dropped", "index": utt.index,
                   "reason": reason, "detail": detail}
        if notice_extra:
            payload.update(notice_extra)
        self.notice(payload)

    async def _process(self, utt):
        rec = {
            "index": utt.index,
            "utterance_s": round(utt.duration_s, 3),
            "speech_s": round(utt.speech_duration_s, 3),
            "hangover_s": round(utt.hangover_s, 3),
            "model_id": self.tts.model,
            "stt_model_id": self.stt.model,
            "voice_settings": dict(self.tts.voice_settings),
        }

        # 1. STT budget. Streaming already metered this utterance hop-by-hop
        # (see feed_hop); a refusal there ended it, and it is dropped here.
        refusal = getattr(utt, "governor_refusal", None)
        if refusal is not None:
            self._drop(utt, "governor_stt", str(refusal),
                       {"governor": refusal.as_dict()})
            return

        # 2. Transcribe. The streamed path only waits for the final; the burst
        # fallback re-sends the whole utterance and so re-reserves it in full —
        # over-counting the streamed part on purpose, the safe direction.
        try:
            if getattr(utt, "committed", False):
                transcript = await self.stt.await_final()
                stt_ms = (time.monotonic() - utt.t_commit) * 1000.0
                rec["stt_path"] = "streamed"
            else:
                try:
                    self.governor.reserve_stt(utt.duration_s)
                except GovernorRefusal as exc:
                    self._drop(utt, "governor_stt", str(exc),
                               {"governor": exc.as_dict()})
                    return
                transcript, stt_ms = await self.stt.transcribe(utt.pcm)
                rec["stt_path"] = "burst_fallback"
        except SttError as exc:
            self._drop(utt, "stt_error", str(exc))
            return
        rec["stt_ms"] = round(stt_ms, 1)
        rec["transcript"] = transcript

        if not transcript.strip():
            # Nothing to say: no TTS call, no spend. Common on a cough that
            # cleared the VAD threshold.
            self._drop(utt, "empty_transcript", f"STT returned nothing in {stt_ms:.0f}ms")
            return

        # WER against the drill script — transcript fidelity is a headline result
        if self.drill_lines:
            line, sc = best_match(transcript, self.drill_lines)
            if sc is not None:
                rec["wer_detail"] = sc
                if sc.get("off_script"):
                    # Free speech, not a failed reading — recorded but not scored
                    rec["off_script"] = True
                else:
                    rec["drill_line"] = line
                    rec["wer"] = sc["wer"]
                    rec["cer"] = sc["cer"]

        # 3. TTS budget — same whole-utterance rule
        chars = len(transcript)
        try:
            self.governor.reserve_tts(chars)
        except GovernorRefusal as refusal:
            rec["chars"] = chars
            self._drop(utt, "governor_tts", str(refusal),
                       {"governor": refusal.as_dict(), "chars": chars})
            return
        rec["chars"] = chars

        # 4. Synthesize, streaming into the jitter buffer
        self._synth_in_flight = True
        first_at = None
        samples = 0
        try:
            async for pcm, ttfb_ms in self.tts.stream(transcript):
                if first_at is None:
                    first_at = time.monotonic()
                    rec["tts_ttfb_ms"] = round(ttfb_ms, 1)
                    rec["tail_latency_ms"] = round(utt.tail_latency_ms(first_at), 1)
                self.queue.push(pcm)
                samples += len(pcm)
        except TtsError as exc:
            self._drop(utt, "tts_error", str(exc))
            return
        finally:
            self._synth_in_flight = False

        if first_at is None:
            self._drop(utt, "tts_empty", "synthesis returned no audio")
            return

        rec["audio_s"] = round(samples / 48000.0, 3)
        rec["spend"] = self.governor.snapshot()
        self.records.append(rec)
        self.event("utterance", **rec)
        self.notice({"type": "tts_utterance", "index": utt.index,
                     "transcript": transcript,
                     "tail_latency_ms": rec.get("tail_latency_ms"),
                     "tts_ttfb_ms": rec.get("tts_ttfb_ms"),
                     "stt_ms": rec.get("stt_ms"),
                     "chars": chars, "model_id": self.tts.model,
                     "wer": rec.get("wer")})
        log.info("utterance %d: %.2fs speech → %r | stt %.0fms | ttfb %.0fms | "
                 "TAIL %.0fms | %d chars | wer=%s",
                 utt.index, utt.speech_duration_s, transcript[:60],
                 rec["stt_ms"], rec.get("tts_ttfb_ms", -1),
                 rec.get("tail_latency_ms", -1), chars, rec.get("wer"))

    # ── reporting ────────────────────────────────────────────────────

    def latency_table(self):
        """p50/p95 of tail_latency and TTFB, grouped by model_id."""
        by_model = {}
        for rec in self.records:
            if rec.get("tail_latency_ms") is None:
                continue
            by_model.setdefault(rec["model_id"], []).append(rec)
        out = {}
        for model, recs in by_model.items():
            out[model] = {
                "n": len(recs),
                "tail_latency_ms": _pct([r["tail_latency_ms"] for r in recs]),
                "tts_ttfb_ms": _pct([r["tts_ttfb_ms"] for r in recs
                                     if r.get("tts_ttfb_ms") is not None]),
                "stt_ms": _pct([r["stt_ms"] for r in recs
                                if r.get("stt_ms") is not None]),
                "chars": sum(r.get("chars", 0) for r in recs),
            }
        return out

    def stats_line(self):
        return (f"tts: utterances={len(self.records)} skipped={self.skipped} "
                f"queued={self._work.qsize()} (max {self.max_queue_depth}) "
                f"speaking={self.speaking} buffer={self.queue.available} samples | "
                f"{self.governor.summary_line()}")


def _pct(values):
    """(p50, p95) with the same index convention as RvcClient.turnaround_ms."""
    if not values:
        return None
    ordered = sorted(values)
    return {
        "p50": round(ordered[len(ordered) // 2], 1),
        "p95": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 1),
        "min": round(min(ordered), 1),
        "max": round(max(ordered), 1),
    }
