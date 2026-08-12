"""TTS engine tests against MOCK vendors — no network, no spend.

The properties that matter for a spike that runs unattended against a funded
account: exactly one STT call per utterance, the governor cannot be talked into
overspending or into truncating, and no vendor failure can take the stream down.
"""

import asyncio
import logging

import numpy as np
import pytest

from bridge import HOP, SR
from elevenlabs_client import SttError, TtsError
from endpointer import PcmQueue, UtteranceEndpointer
from spend_governor import SKIP_MARKER, SpendGovernor
from tts_engine import TtsEngine
from vad import OutputGate


# ── mock vendors ─────────────────────────────────────────────────────


class MockStt:
    """Mirrors SttClient's streaming contract: begin/push/commit/await_final,
    with transcribe() as the burst fallback."""

    model = "mock_stt"

    def __init__(self, texts=None, error=None, stream_fails=False):
        self.texts = list(texts or [])
        self.error = error
        self.stream_fails = stream_fails
        self.calls = []          # one entry per transcribe() — burst fallback only
        self.pushed = []         # hops streamed while the gate was open
        self.commits = 0         # exactly one per streamed utterance
        self.begins = 0
        self.fallbacks = 0
        self.abandons = 0

    def _next_text(self):
        return self.texts.pop(0) if self.texts else "hello there"

    def abandon_utterance(self):
        self.abandons += 1

    async def begin_utterance(self):
        self.begins += 1
        return not self.stream_fails

    async def push(self, pcm):
        if not self.stream_fails:
            self.pushed.append(np.asarray(pcm))

    async def commit(self):
        if self.stream_fails:
            return False
        self.commits += 1
        return True

    async def await_final(self):
        if self.error:
            raise self.error
        return self._next_text()

    async def transcribe(self, pcm):
        self.calls.append(np.asarray(pcm))
        if self.error:
            raise self.error
        return self._next_text(), 11.0


class MockTts:
    def __init__(self, model="mock_tts", error=None, chunks=None):
        self.model = model
        self.voice_id = "mock_voice_id"
        self.session = None      # _switch_voice reaches for these; fetch is mocked
        self.api_key = "mock"
        self.voice_settings = {"stability": 0.71, "similarity_boost": 0.91}
        self.error = error
        self.chunks = chunks
        self.calls = []          # one entry per stream() — the text it got
        self.prev_ids = []       # previous_request_ids seen per stream() call
        self.last_request_id = None
        self.warmups = 0         # one per warm_on_join / preflight warmup

    async def stream(self, text, previous_request_ids=None):
        self.calls.append(text)
        self.prev_ids.append(previous_request_ids)
        if self.error:
            raise self.error
        for chunk in (self.chunks
                      if self.chunks is not None
                      else [np.full(2400, 0.3, dtype=np.float32)] * 2):
            yield chunk, 7.5
        # body fully read → request-id available to condition the next call
        self.last_request_id = f"req-{len(self.calls)}"

    # Phase 4 console contract (mirrors TtsClient)
    def set_model(self, model_id):
        self.model = model_id

    def set_voice(self, voice_id, voice_settings=None):
        self.voice_id = voice_id
        if voice_settings is not None:
            self.voice_settings = dict(voice_settings)

    def apply_voice_setting(self, field, value):
        self.voice_settings[field] = value

    async def warmup(self, governor=None):
        self.warmups += 1
        if governor is not None:
            governor.reserve_tts(1)      # metered exactly like the real warmup
        if self.error:
            raise self.error
        return 42.0


def build(stt=None, tts=None, max_tts_chars=10_000, max_stt_seconds=1000,
          drill=None):
    events, notices = [], []
    queue = PcmQueue()
    engine = TtsEngine(
        stt=stt or MockStt(),
        tts=tts or MockTts(),
        governor=SpendGovernor(max_tts_chars=max_tts_chars,
                               max_stt_seconds=max_stt_seconds),
        endpointer=UtteranceEndpointer(),
        queue=queue,
        outgate=OutputGate(queue, prime_samples=480),
        drill_lines=drill,
        on_event=lambda kind, **f: events.append((kind, f)),
        on_notice=notices.append,
    )
    return engine, events, notices


async def utter(engine, n_speech=5, n_hangover=0, value=0.2):
    """Feed one complete utterance: speech hops, hangover hops, then gate close."""
    for _ in range(n_speech):
        await engine.feed_hop(np.full(HOP, value, dtype=np.float32), True, True)
    for _ in range(n_hangover):
        await engine.feed_hop(np.zeros(HOP, dtype=np.float32), True, False)
    await engine.feed_hop(np.zeros(HOP, dtype=np.float32), False, False)


async def wait_done(engine, n, timeout=3.0):
    """Wait until n utterances have reached a terminal state (kept or dropped)."""
    for _ in range(int(timeout / 0.005)):
        if len(engine.records) + engine.skipped >= n:
            await asyncio.sleep(0.02)      # let trailing bookkeeping land
            return
        await asyncio.sleep(0.005)
    raise AssertionError(
        f"only {len(engine.records) + engine.skipped}/{n} utterances completed")


# ── endpointing contract ─────────────────────────────────────────────


def test_exactly_one_commit_per_utterance():
    """AMENDED CONTRACT (optimization sprint): audio is streamed while the gate
    is open, so "one STT call per utterance" is now "one COMMIT per utterance".
    That is the invariant that ever mattered — a second commit would split one
    thought into two transcripts and desynchronize the FIFO the worker relies
    on to match transcripts to utterances."""
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        for _ in range(3):
            await utter(engine, n_speech=4)
        await wait_done(engine, 3)
        await engine.aclose()

    asyncio.run(run())
    assert stt.commits == 3
    assert stt.begins == 3
    assert stt.calls == []          # the burst fallback was never needed


def test_audio_streams_while_open_but_nothing_is_COMMITTED_until_close():
    """The amended contract, precisely: bytes may leave early — a transcript
    may not. Committing mid-utterance would transcribe half a sentence."""
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        for _ in range(40):        # a long open gate — over 5 seconds of speech
            await engine.feed_hop(np.full(HOP, 0.2, dtype=np.float32), True, True)
        for _ in range(50):
            await asyncio.sleep(0.001)
        assert len(stt.pushed) == 40   # audio DID stream out (the whole point)
        assert stt.commits == 0        # but not a single commit yet
        assert engine.records == []    # and no transcript, so nothing synthesized
        await engine.feed_hop(np.zeros(HOP, dtype=np.float32), False, False)
        await wait_done(engine, 1)
        await engine.aclose()

    asyncio.run(run())
    assert stt.commits == 1


def test_hangover_audio_is_streamed_before_the_commit():
    """Trailing consonants live in the hangover; they must reach STT before the
    commit closes the segment, or the endpointer becomes a word-clipper."""
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        await utter(engine, n_speech=4, n_hangover=3)
        await wait_done(engine, 1)
        await engine.aclose()

    asyncio.run(run())
    assert len(stt.pushed) == 7      # 4 speech + 3 hangover hops, all streamed
    assert stt.commits == 1


def test_streaming_failure_falls_back_to_burst_upload():
    """Fail-open: if the stream breaks, the utterance is still transcribed via
    the proven burst path rather than lost."""
    stt = MockStt(stream_fails=True)

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        await utter(engine, n_speech=4, n_hangover=2)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert stt.commits == 0
    assert len(stt.calls) == 1                    # burst fallback carried it
    assert len(stt.calls[0]) == 6 * HOP           # the whole utterance
    assert engine.records[0]["stt_path"] == "burst_fallback"
    assert len(engine.records) == 1               # nothing was lost


def test_tail_latency_is_measured_from_the_end_of_SPEECH():
    """With 3 hangover hops (384 ms), even instant synthesis cannot beat 384 ms
    — because the clock starts when the human stopped talking."""
    async def run(n_hangover):
        engine, _, _ = build()
        engine.start()
        await utter(engine, n_speech=4, n_hangover=n_hangover)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine.records[0]["tail_latency_ms"]

    with_hangover = asyncio.run(run(3))
    without = asyncio.run(run(0))
    assert with_hangover >= 3 * HOP / SR * 1000 - 1     # >= ~384 ms
    assert without < 100                               # mocks are instant


# ── the governor ─────────────────────────────────────────────────────


def test_tts_refusal_skips_the_utterance_whole_and_never_truncates():
    tts = MockTts()

    async def run():
        # room for the first transcript ("hello there" = 11) but not a second
        engine, events, notices = build(tts=tts, max_tts_chars=11)
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await utter(engine)
        await wait_done(engine, 2)
        await engine.aclose()
        return engine, events, notices

    engine, events, notices = asyncio.run(run())
    assert len(tts.calls) == 1                     # second never synthesized
    assert tts.calls == ["hello there"]             # and NOT a truncated prefix
    assert engine.governor.tts_chars_used == 11     # meter untouched by the refusal
    assert engine.skipped == 1
    dropped = [n for n in notices if n["type"] == "tts_utterance_dropped"]
    assert dropped[0]["reason"] == "governor_tts"
    assert dropped[0]["governor"]["remaining"] == 0
    # the skip is also on the capture timeline, with the arithmetic that caused it
    drops = [f for kind, f in events if kind == "utterance_dropped"]
    assert drops[0]["reason"] == "governor_tts"
    assert drops[0]["governor"]["cap"] == 11


def test_stt_refusal_makes_no_vendor_call_at_all():
    stt, tts = MockStt(), MockTts()

    async def run():
        engine, _, notices = build(stt=stt, tts=tts, max_stt_seconds=0.1)
        engine.start()
        await utter(engine, n_speech=5)                  # 5 hops = 640 ms > 0.1 s
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    assert stt.calls == [] and tts.calls == []
    assert engine.skipped == 1
    assert notices[0]["reason"] == "governor_stt"


def test_agent_survives_a_refusal_and_processes_the_next_utterance():
    """A refusal is not a latch: a short utterance still fits afterwards."""
    stt = MockStt(texts=["a very long transcript indeed", "hi"])
    tts = MockTts()

    async def run():
        engine, _, _ = build(stt=stt, tts=tts, max_tts_chars=12)
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await utter(engine)
        await wait_done(engine, 2)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert tts.calls == ["hi"]                     # the affordable one went through
    assert engine.skipped == 1 and len(engine.records) == 1


def test_refusal_is_loud_and_unmistakable_in_the_logs(caplog):
    async def run():
        engine, _, _ = build(max_tts_chars=1)
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()

    with caplog.at_level(logging.ERROR, logger="governor"):
        asyncio.run(run())
    assert any(SKIP_MARKER in r.getMessage() for r in caplog.records)


# ── fail-open: no vendor failure takes the stream down ───────────────


def test_stt_error_drops_only_that_utterance():
    tts = MockTts()

    async def run():
        engine, _, notices = build(stt=MockStt(error=SttError("socket died")),
                                   tts=tts)
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    assert tts.calls == []                         # never reached synthesis
    assert engine.skipped == 1
    assert notices[0]["reason"] == "stt_error"
    assert "socket died" in notices[0]["detail"]


def test_tts_error_drops_only_that_utterance_and_the_next_proceeds():
    async def run():
        good = MockTts()
        engine, _, notices = build(tts=MockTts(error=TtsError("HTTP 500")))
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        engine.tts = good                          # vendor recovers
        await utter(engine)
        await wait_done(engine, 2)
        await engine.aclose()
        return engine, notices, good

    engine, notices, good = asyncio.run(run())
    assert engine.skipped == 1
    assert notices[0]["reason"] == "tts_error"
    assert len(good.calls) == 1                    # stream survived and continued
    assert len(engine.records) == 1


def test_empty_transcript_costs_no_tts_call():
    tts = MockTts()

    async def run():
        engine, _, notices = build(stt=MockStt(texts=["   "]), tts=tts)
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    assert tts.calls == []
    assert engine.governor.tts_chars_used == 0
    assert notices[0]["reason"] == "empty_transcript"


def test_an_unexpected_error_does_not_kill_the_worker():
    class Exploding(MockStt):
        async def await_final(self):     # the streaming path the engine now uses
            raise RuntimeError("something nobody predicted")

    async def run():
        engine, _, _ = build(stt=Exploding())
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        # the worker must still be alive to take the next one
        assert engine._worker_task is not None and not engine._worker_task.done()
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert engine.skipped == 1


# ── output path ──────────────────────────────────────────────────────


def test_synthesized_audio_reaches_the_publisher_contiguously():
    """48k mono into the jitter buffer with no discontinuity at chunk edges."""
    t = np.arange(9600, dtype=np.float32)
    sine = np.sin(2 * np.pi * 440 * t / 48000).astype(np.float32)
    chunks = [sine[i:i + 1100] for i in range(0, len(sine), 1100)]

    async def run():
        engine, _, _ = build(tts=MockTts(chunks=chunks))
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        frames = [engine.read_frame(480) for _ in range(25)]
        await engine.aclose()
        return np.concatenate(frames)

    out = asyncio.run(run())
    assert len(out) == 25 * 480
    voiced = out[np.abs(out) > 1e-6]
    assert len(voiced) > 8000                       # the audio actually played
    # no splice clicks: a 440 Hz sine's own step is ~0.058 at 48k
    assert np.max(np.abs(np.diff(out))) < 0.15


def test_output_is_silence_when_nothing_has_been_said():
    async def run():
        engine, _, _ = build()
        engine.start()
        frames = [engine.read_frame(480) for _ in range(5)]
        await engine.aclose()
        return np.concatenate(frames)

    assert not np.any(asyncio.run(run()))


# ── metrics ──────────────────────────────────────────────────────────


def test_per_utterance_record_carries_the_tuning_context():
    async def run():
        engine, events, _ = build(tts=MockTts(model="eleven_flash_v2_5"))
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, events

    engine, events = asyncio.run(run())
    rec = engine.records[0]
    for field in ("stt_ms", "transcript", "tts_ttfb_ms", "tail_latency_ms",
                  "chars", "model_id", "stt_model_id", "voice_settings",
                  "utterance_s", "speech_s", "spend"):
        assert field in rec, field
    assert rec["model_id"] == "eleven_flash_v2_5"
    assert rec["voice_settings"]["stability"] == 0.71
    # and the same record lands in meta.jsonl for analyze_capture.py to align
    kinds = [k for k, _ in events]
    assert "utterance_end" in kinds and "utterance" in kinds


def test_wer_is_scored_against_the_drill_script():
    async def run():
        engine, _, _ = build(
            stt=MockStt(texts=["the quick brown fox jumps over the lazy dog"]),
            drill=["The quick brown fox jumps over the lazy dog.",
                   "Mic test one two."])
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine.records[0]

    rec = asyncio.run(run())
    assert rec["wer"] == 0.0                        # punctuation/case normalized
    assert rec["drill_line"].startswith("The quick brown fox")


def test_wer_counts_a_real_mishearing():
    async def run():
        engine, _, _ = build(
            stt=MockStt(texts=["the quick brown box jumps over the lazy dog"]),
            drill=["The quick brown fox jumps over the lazy dog."])
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine.records[0]

    rec = asyncio.run(run())
    assert rec["wer"] == round(1 / 9, 4)            # one substitution in 9 words


def test_latency_table_groups_by_model():
    async def run():
        engine, _, _ = build(tts=MockTts(model="eleven_v3"))
        engine.start()
        for _ in range(3):
            await utter(engine)
        await wait_done(engine, 3)
        await engine.aclose()
        return engine.latency_table()

    table = asyncio.run(run())
    assert set(table) == {"eleven_v3"}
    assert table["eleven_v3"]["n"] == 3
    for key in ("p50", "p95", "min", "max"):
        assert key in table["eleven_v3"]["tail_latency_ms"]


# ── regressions from the live session (28 Jul) ───────────────────────


def test_off_script_speech_is_recorded_but_not_scored():
    async def run():
        engine, _, _ = build(
            stt=MockStt(texts=["hey how are you doing today"]),
            drill=["The quick brown fox jumps over the lazy dog."])
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine.records[0]

    rec = asyncio.run(run())
    assert rec["off_script"] is True
    assert "wer" not in rec              # not scored as a failed reading
    assert rec["transcript"]             # but the transcript is still kept


def test_a_dropped_utterance_is_visible_in_the_log(caplog):
    """skipped=1 with nothing in the log is the ambiguity we refuse to ship."""
    async def run():
        engine, _, _ = build(stt=MockStt(error=SttError("socket died")))
        engine.start()
        await utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()

    with caplog.at_level(logging.WARNING, logger="tts-engine"):
        asyncio.run(run())
    msgs = [r.getMessage() for r in caplog.records]
    assert any("dropped" in m and "stt_error" in m and "socket died" in m
               for m in msgs), msgs


# ── the governor under streaming (optimization sprint) ───────────────


def test_streaming_meters_every_hop_before_it_is_sent():
    """Streaming bills as it goes, so the reservation must precede the send.
    5 hops of 128ms = 0.64s; a 0.4s cap must stop the audio going out."""
    stt = MockStt()

    async def run():
        engine, _, notices = build(stt=stt, max_stt_seconds=0.4)
        engine.start()
        await utter(engine, n_speech=5)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    assert len(stt.pushed) == 3                    # 3 x 128ms fits in 0.4s, 4th does not
    assert engine.governor.stt_seconds_used <= 0.4  # the cap was never exceeded
    assert stt.commits == 0                        # abandoned, never committed
    assert engine.skipped == 1
    assert notices[0]["reason"] == "governor_stt"


def test_an_abandoned_utterance_produces_no_audio_at_all():
    """"Skipped whole" under streaming means no transcript and no synthesis —
    nothing half-spoken reaches the listener, which is the rule that matters."""
    tts = MockTts()

    async def run():
        engine, _, _ = build(tts=tts, max_stt_seconds=0.2)
        engine.start()
        await utter(engine, n_speech=6)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert tts.calls == []
    assert engine.governor.tts_chars_used == 0
    assert engine.queue.available == 0


# ── loudness normalization (post-Stage-1 ticket 1) ────────────────────


def test_loudness_normalization_levels_the_utterance_and_records_it():
    """Default ON: the whole utterance is buffered, measured, and enqueued as one
    normalized block at the target RMS — and the leveling is recorded + notified."""
    tts = MockTts(chunks=[np.full(2400, 0.3, dtype=np.float32)] * 2)  # -10.5 dBFS

    async def run():
        engine, _, notices = build(tts=tts)
        engine.normalizer.set_target_db(-20.0)          # target RMS 0.1
        engine.start()
        await utter(engine, n_speech=5)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    rec = engine.records[0]
    assert rec["loudness"]["applied"] is True
    assert rec["loudness"]["out_db"] == pytest.approx(-20.0, abs=0.3)
    assert "enqueue_delay_ms" in rec                    # the buffering cost is reported
    # one normalized block, leveled to ~0.1 (the target), never clipped
    assert engine.queue.chunks_pushed == 1
    peak = float(np.max(np.abs(engine.queue._buf)))
    assert peak < 1.0
    assert peak == pytest.approx(0.1, abs=0.02)
    # the console panel gets the leveling evidence too
    utt_notice = next(n for n in notices if n.get("type") == "tts_utterance")
    assert utt_notice["loudness"]["out_db"] == pytest.approx(-20.0, abs=0.3)


def test_loudness_off_streams_raw_chunks_byte_identical():
    """Disabled ⇒ the original chunk-by-chunk streaming, untouched: each chunk is
    pushed as it arrives and the samples are exactly what the vendor sent."""
    raw = [np.full(2400, 0.3, dtype=np.float32),
           np.full(1600, 0.42, dtype=np.float32)]
    tts = MockTts(chunks=[c.copy() for c in raw])

    async def run():
        engine, _, _ = build(tts=tts)
        engine.normalizer.set_enabled(False)
        engine.start()
        await utter(engine, n_speech=5)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert engine.queue.chunks_pushed == 2              # streamed, not merged into one
    np.testing.assert_array_equal(engine.queue._buf, np.concatenate(raw))
    assert "loudness" not in engine.records[0]          # nothing measured or applied


def test_a_lost_streamed_transcript_is_recovered_from_the_buffer():
    """Observed live TWICE: the session's FIRST utterance commits onto a socket
    that idled out while nobody was speaking, and the transcript never arrives.
    The endpointer still holds the audio, so it must be re-sent rather than
    lost — it is the one sentence a person always notices."""
    class LosesTheFinal(MockStt):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.final_calls = 0

        async def await_final(self):
            self.final_calls += 1
            if self.final_calls == 1:
                raise SttError("socket closed before a final transcript")
            return self._next_text()

    stt = LosesTheFinal(texts=["recovered sentence", "second sentence"])

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await utter(engine, n_speech=4)
        await wait_done(engine, 2)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert engine.skipped == 0                       # nothing lost
    assert len(engine.records) == 2
    assert engine.records[0]["stt_path"] == "streamed_then_burst_retry"
    assert engine.records[0]["transcript"] == "recovered sentence"
    assert len(stt.calls) == 1                       # exactly one re-send
    assert engine.records[1]["stt_path"] == "streamed"   # and it recovers after


def test_the_default_engine_is_tts():
    """The pivot, asserted in code so it cannot drift back silently.

    Promoted 28 Jul 2026 on measured evidence (tail_latency p50 1938 -> 932 ms
    with transcripts and quality unchanged). RVC is NOT removed — `--engine rvc`
    remains the parked baseline and fallback, which the second assertion pins.
    """
    import pathlib as _p
    import subprocess
    import sys

    import convert_agent

    out = subprocess.run(
        [sys.executable, str(_p.Path(convert_agent.__file__)), "--help"],
        capture_output=True, text=True, timeout=120).stdout
    assert "tts (DEFAULT" in out          # the promoted default
    assert convert_agent.ENGINES == ("rvc", "tts")   # rvc still selectable


# ── findings round (CodeRabbit + CTO annotations) ────────────────────


def test_a_dropped_blip_does_not_leak_state_into_the_next_utterance():
    """The blip returns None at gate-close. Without an explicit reset the next
    utterance skips begin_utterance() and inherits the blip's streaming state
    and its half-streamed, uncommitted server-side segment."""
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        # one hop of speech = 128ms, under the 200ms min_speech_ms floor
        await engine.feed_hop(np.full(HOP, 0.2, dtype=np.float32), True, True)
        await engine.feed_hop(np.zeros(HOP, dtype=np.float32), False, False)
        assert engine._utt_streaming is False      # reset on the no-utterance path
        assert stt.abandons == 1                   # and the segment was abandoned
        await utter(engine, n_speech=4)            # a real one follows
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert stt.begins == 2          # the real utterance DID start its own stream
    assert stt.commits == 1
    assert len(engine.records) == 1


def test_mode_reentry_drops_queued_utterances():
    """Ghost audio guard: anything queued belongs to the previous take."""
    async def run():
        engine, _, _ = build()
        engine.start()
        engine._work.put_nowait(object())     # a stale job, never processed
        engine.reset()
        assert engine._work.qsize() == 0
        assert engine.generation == 1
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert len(engine.records) == 1           # the post-reset utterance is fine


def test_synthesis_in_flight_at_mode_reentry_never_reaches_the_room():
    """The worst case: audio already streaming when the mode flips. It must be
    discarded rather than pushed into the freshly-cleared jitter buffer."""
    class SlowTts(MockTts):
        def __init__(self, engine_ref, **kw):
            super().__init__(**kw)
            self.engine_ref = engine_ref

        async def stream(self, text):
            self.calls.append(text)
            # the mode is re-entered between the first and second chunk
            yield np.full(1200, 0.3, dtype=np.float32), 7.5
            self.engine_ref[0].reset()
            yield np.full(1200, 0.3, dtype=np.float32), 7.5

    async def run():
        ref = []
        engine, _, _ = build(tts=SlowTts(ref))
        ref.append(engine)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine

    engine = asyncio.run(run())
    assert engine.skipped == 1
    assert engine.records == []               # nothing recorded from the old take
    assert engine.queue.available == 0        # and no ghost audio buffered


def test_queue_wait_is_measured_not_inferred_from_depth():
    """qsize() is always >= 1 for the utterance just enqueued, so depth cannot
    express 'this one waited'. The wait itself is recorded per utterance."""
    async def run():
        engine, _, _ = build()
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine.records[0]

    rec = asyncio.run(run())
    assert "queue_wait_ms" in rec
    assert rec["queue_wait_ms"] >= 0


# ── Phase 4 console: warm-on-join, live tuning, per-model filtering ──


def test_warm_on_join_fires_a_metered_synthesis():
    """VPS-drill fix: a participant joining re-warms the vendor voice model so
    their first utterance doesn't pay the cold-start TTFB. It is a real 1-char
    synthesis (metered), not the free keepalive GET ping — a ping cannot move
    TTFB (see TtsEngine.warm_on_join)."""
    async def run():
        engine, _, _ = build()
        before = engine.governor.tts_chars_used
        await engine.warm_on_join()
        return engine, before

    engine, before = asyncio.run(run())
    assert engine.tts.warmups == 1
    assert engine.governor.tts_chars_used == before + 1   # metered exactly 1 char


def test_warm_on_join_skipped_while_synthesis_in_flight():
    """Skipped when a synthesis is already running (the model is warm) and when
    another warm is in flight — idempotent under rapid joins, never concurrent."""
    async def run():
        engine, _, _ = build()
        engine._synth_in_flight = True
        await engine.warm_on_join()
        assert engine.tts.warmups == 0        # in flight → skipped
        engine._synth_in_flight = False
        engine._warming = True
        await engine.warm_on_join()
        assert engine.tts.warmups == 0        # already warming → skipped

    asyncio.run(run())


def test_warm_on_join_never_raises_on_vendor_error():
    """Fail-open: a warm that errors (or a governor refusal) is logged, never
    raised — a cold first utterance is a latency cost, not a crash."""
    async def run():
        engine, _, _ = build(tts=MockTts(error=TtsError("boom")))
        await engine.warm_on_join()           # must not raise
        engine2, _, _ = build(max_tts_chars=0)  # governor refuses the 1 char
        await engine2.warm_on_join()           # must not raise
        return engine

    engine = asyncio.run(run())
    assert engine._warming is False           # flag always released


def test_effective_voice_settings_filters_unsupported_by_model():
    """TtsClient sends only the settings the CURRENT model supports — Eleven v3
    drops similarity_boost and use_speaker_boost (ElevenLabs docs). Pure dict
    work, no network."""
    from elevenlabs_client import TtsClient
    vs = {"stability": 0.5, "similarity_boost": 0.9,
          "style": 0.2, "use_speaker_boost": True, "speed": 1.0}
    flash = TtsClient(None, "k", "v", model="eleven_flash_v2_5", voice_settings=dict(vs))
    assert flash.effective_voice_settings() == vs          # flash keeps everything
    v3 = TtsClient(None, "k", "v", model="eleven_v3", voice_settings=dict(vs))
    eff = v3.effective_voice_settings()
    assert "similarity_boost" not in eff and "use_speaker_boost" not in eff
    assert eff == {"stability": 0.5, "style": 0.2, "speed": 1.0}


def _tts_agent():
    """A disconnected ConvertAgent wrapping a mock tts engine — _publish_config
    no-ops while disconnected, so _apply_config runs fully offline."""
    from convert_agent import ConvertAgent
    from vad import VadGate
    engine, events, notices = build()
    vad = VadGate(prob_fn=lambda c: 0.0)
    agent = ConvertAgent("room", "echo-test", "ws://127.0.0.1:9", "convert",
                         vad=vad, engine="tts", tts_engine=engine)
    return agent, engine, events


def test_agent_applies_tts_voice_settings_and_model():
    """set_config in tts mode: voice settings + model land on the TtsClient and
    the snapshot renders APPLIED truth (flat knob keys the console reads)."""
    async def run():
        agent, engine, _ = _tts_agent()
        await agent._apply_config({
            "tts_model": "eleven_multilingual_v2",
            "stability": 0.3,
            "style": 0.9,
            "speed": 1.1,
            "use_speaker_boost": False,
            "min_speech_ms": 150,
            "queue_wait_warn_ms": 400,
            "vad_threshold": 0.8,
        }, "test")
        return agent, engine

    agent, engine = asyncio.run(run())
    assert engine.tts.model == "eleven_multilingual_v2"
    assert engine.tts.voice_settings["stability"] == 0.3
    assert engine.tts.voice_settings["style"] == 0.9
    assert engine.tts.voice_settings["use_speaker_boost"] is False
    assert engine.endpointer.min_speech_ms == 150
    assert engine.queue_wait_warn_ms == 400
    snap = agent.config_snapshot()
    assert snap["tts_model"] == "eleven_multilingual_v2"   # flat key for the UI
    assert snap["stability"] == 0.3                        # voice settings flattened
    assert snap["speed"] == 1.1
    assert snap["min_speech_ms"] == 150
    assert snap["vad_threshold"] == 0.8


def test_agent_rejects_setting_unsupported_by_target_model():
    """Switching to eleven_v3 AND setting similarity_boost in one payload:
    the model change wins, similarity_boost is REJECTED with the reason (never
    silently ignored), and the stored value is untouched."""
    async def run():
        agent, engine, _ = _tts_agent()
        engine.tts.voice_settings["similarity_boost"] = 0.91
        captured = {}

        async def cap(adjusted=None, rejected=None):
            captured["rejected"] = rejected

        agent._publish_config = cap
        await agent._apply_config(
            {"tts_model": "eleven_v3", "similarity_boost": 0.4,
             "use_speaker_boost": True, "stability": 0.6}, "test")
        return agent, engine, captured

    agent, engine, captured = asyncio.run(run())
    assert engine.tts.model == "eleven_v3"                 # model change applied
    assert engine.tts.voice_settings["stability"] == 0.6   # supported → applied
    assert engine.tts.voice_settings["similarity_boost"] == 0.91  # untouched
    rej = captured["rejected"]
    assert "similarity_boost" in rej and "use_speaker_boost" in rej
    assert "v3" in rej["similarity_boost"]                 # reason carries the model


def test_agent_rejects_rvc_only_knob_in_tts_mode():
    """An rvc knob sent to a tts agent is rejected with a clear reason, not
    silently dropped or applied to a non-existent RVC engine."""
    async def run():
        agent, _, _ = _tts_agent()
        captured = {}

        async def cap(adjusted=None, rejected=None):
            captured["rejected"] = rejected

        agent._publish_config = cap
        await agent._apply_config({"index_rate": 0.5, "f0_method": "harvest"}, "t")
        return captured

    captured = asyncio.run(run())
    assert set(captured["rejected"]) == {"index_rate", "f0_method"}
    assert "no RVC engine" in captured["rejected"]["index_rate"]


# ── Ticket 1: request continuity (stitching) ─────────────────────────


def test_continuity_conditions_each_utterance_on_the_previous():
    """Request stitching: the 2nd utterance conditions on the 1st's request-id,
    so a session holds one delivery. The 1st has no predecessor."""
    tts = MockTts()

    async def run():
        engine, _, _ = build(tts=tts)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await utter(engine, n_speech=4)
        await wait_done(engine, 2)
        await engine.aclose()

    asyncio.run(run())
    assert tts.prev_ids == [None, ["req-1"]]     # 1st unconditioned, 2nd stitched


def test_continuity_off_sends_no_previous_ids():
    tts = MockTts()

    async def run():
        engine, _, _ = build(tts=tts)
        engine.request_continuity = False
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await utter(engine, n_speech=4)
        await wait_done(engine, 2)
        await engine.aclose()

    asyncio.run(run())
    assert tts.prev_ids == [None, None]          # toggle off → never conditioned


def test_continuity_not_sent_to_v3_even_when_enabled():
    """eleven_v3 has no request stitching — the engine must not send it a field
    the model rejects, regardless of the toggle."""
    tts = MockTts(model="eleven_v3")

    async def run():
        engine, _, _ = build(tts=tts)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await utter(engine, n_speech=4)
        await wait_done(engine, 2)
        await engine.aclose()

    asyncio.run(run())
    assert tts.prev_ids == [None, None]


def test_continuity_resets_on_mode_reentry():
    """reset() (mode re-entry / session end) clears the stitching anchor so the
    next take doesn't stitch onto audio from before the toggle."""
    tts = MockTts()

    async def run():
        engine, _, _ = build(tts=tts)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        engine.reset()                            # session boundary
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)                # records reset by generation bump? no — count kept
        await engine.aclose()
        return engine

    asyncio.run(run())
    assert tts.prev_ids == [None, None]           # 2nd started a fresh chain


def test_reset_continuity_clears_the_anchor():
    async def run():
        engine, _, _ = build()
        engine._prev_request_id = "req-9"
        engine.reset_continuity()
        assert engine._prev_request_id is None

    asyncio.run(run())


# ── Ticket 6: voice selector ─────────────────────────────────────────


def test_agent_voice_switch_validates_loads_settings_and_resets_continuity(monkeypatch):
    """A valid voice switch: loads the NEW voice's own settings (applied truth),
    resets continuity, and the snapshot shows the new voice — no stale sliders."""
    import convert_agent

    async def fake_fetch_voice(session, api_key, voice_id):
        return {"name": "Bright Clone", "category": "cloned",
                "settings": {"stability": 0.2, "similarity_boost": 0.5, "style": 0.4}}
    monkeypatch.setattr(convert_agent, "fetch_voice", fake_fetch_voice)

    async def run():
        agent, engine, _ = _tts_agent()
        engine.voices = [{"voice_id": "v_new", "name": "Bright Clone", "category": "cloned"}]
        engine._prev_request_id = "req-5"
        await agent._apply_config({"voice": "v_new"}, "test")
        return agent, engine

    agent, engine = asyncio.run(run())
    assert engine.tts.voice_id == "v_new"
    assert engine.tts.voice_settings["stability"] == 0.2      # new voice's own settings
    assert engine._prev_request_id is None                    # continuity reset
    snap = agent.config_snapshot()
    assert snap["voice"] == "v_new" and snap["voice_name"] == "Bright Clone"


def test_agent_voice_switch_relists_on_cache_miss(monkeypatch):
    """A voice cloned AFTER startup is applied on first request: the agent
    re-lists once on cache miss instead of rejecting (CEO, 12 Aug 2026 —
    clone it, then speak in it, no reconnect)."""
    import convert_agent

    async def fake_fetch_voice(session, api_key, voice_id):
        return {"name": "Fresh Clone", "category": "cloned",
                "settings": {"stability": 0.3, "similarity_boost": 0.6}}
    monkeypatch.setattr(convert_agent, "fetch_voice", fake_fetch_voice)
    listed = {"calls": 0}

    async def fake_list(session, api_key):
        listed["calls"] += 1
        return [{"voice_id": "v_fresh", "name": "Fresh Clone", "category": "cloned"}]
    monkeypatch.setattr(convert_agent, "list_voices", fake_list)

    async def run():
        agent, engine, _ = _tts_agent()
        engine.voices = [{"voice_id": "v_old", "name": "Old", "category": "premade"}]
        await agent._apply_config({"voice": "v_fresh"}, "test")
        return agent, engine

    agent, engine = asyncio.run(run())
    assert engine.tts.voice_id == "v_fresh"
    assert listed["calls"] == 1
    assert any(v["voice_id"] == "v_fresh" for v in engine.voices)  # cache adopted


def test_agent_voice_switch_refresh_does_not_bypass_policy(monkeypatch):
    """The re-list serves freshness, not privilege: an 'own'-restricted
    session still cannot switch to a clone outside its stamped ids — the
    fresh list is consulted, the policy wall stands."""
    import convert_agent

    async def fake_list(session, api_key):
        return [{"voice_id": "v_other", "name": "Someone Else", "category": "cloned"}]
    monkeypatch.setattr(convert_agent, "list_voices", fake_list)

    async def run():
        agent, engine, _ = _tts_agent()
        engine.voices = []
        captured = {}

        async def cap(adjusted=None, rejected=None):
            captured["rejected"] = rejected

        agent._publish_config = cap
        await agent._apply_config({"voice": "v_other"}, "test", policy=("own", set()))
        return engine, captured

    engine, captured = asyncio.run(run())
    assert engine.tts.voice_id == "mock_voice_id"                 # unchanged
    assert "unknown voice_id" in captured["rejected"]["voice"]


def test_agent_voice_switch_empty_relist_keeps_cache_and_rejects(monkeypatch):
    """A transient listing failure (empty answer) must not blank the known
    list — the cache stays, the request is rejected, nothing crashes."""
    import convert_agent

    async def fake_list(session, api_key):
        return []
    monkeypatch.setattr(convert_agent, "list_voices", fake_list)

    async def run():
        agent, engine, _ = _tts_agent()
        engine.voices = [{"voice_id": "v_ok", "name": "OK", "category": "premade"}]
        captured = {}

        async def cap(adjusted=None, rejected=None):
            captured["rejected"] = rejected

        agent._publish_config = cap
        await agent._apply_config({"voice": "v_ghost"}, "test")
        return engine, captured

    engine, captured = asyncio.run(run())
    assert [v["voice_id"] for v in engine.voices] == ["v_ok"]     # cache kept
    assert "unknown voice_id" in captured["rejected"]["voice"]


def test_agent_rejects_unknown_voice(monkeypatch):
    import convert_agent

    async def run():
        agent, engine, _ = _tts_agent()
        engine.voices = [{"voice_id": "v_ok", "name": "OK", "category": "cloned"}]
        captured = {}

        async def cap(adjusted=None, rejected=None):
            captured["rejected"] = rejected

        agent._publish_config = cap
        await agent._apply_config({"voice": "v_ghost"}, "test")
        return engine, captured

    engine, captured = asyncio.run(run())
    assert engine.tts.voice_id == "mock_voice_id"             # unchanged
    assert "voice" in captured["rejected"]
    assert "unknown voice_id" in captured["rejected"]["voice"]


# ── Ticket 2: comfort noise applied truth ────────────────────────────


def test_agent_applies_comfort_noise_db():
    async def run():
        agent, engine, _ = _tts_agent()
        await agent._apply_config({"comfort_noise_db": -45.0}, "test")
        return agent, engine

    agent, engine = asyncio.run(run())
    assert engine.outgate.comfort is not None
    assert engine.outgate.comfort.db == -45.0
    assert agent.config_snapshot()["comfort_noise_db"] == -45.0


# ── Ticket 3: STT punctuation reaches synthesis untouched ────────────


def test_transcript_punctuation_reaches_synthesis_untouched():
    """Punctuation is the free prosody channel — Scribe emits ? ! …, and the
    pipeline must hand it to TTS verbatim (only whitespace is trimmed)."""
    tts = MockTts()

    async def run():
        engine, _, _ = build(stt=MockStt(texts=["Really?! Wait… no."]), tts=tts)
        engine.start()
        await utter(engine, n_speech=4)
        await wait_done(engine, 1)
        await engine.aclose()

    asyncio.run(run())
    assert tts.calls == ["Really?! Wait… no."]   # exact — no punctuation stripped
