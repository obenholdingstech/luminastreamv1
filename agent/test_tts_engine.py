"""TTS engine tests against MOCK vendors — no network, no spend.

The properties that matter for a spike that runs unattended against a funded
account: exactly one STT call per utterance, the governor cannot be talked into
overspending or into truncating, and no vendor failure can take the stream down.
"""

import asyncio
import logging

import numpy as np

from bridge import HOP, SR
from elevenlabs_client import SttError, TtsError
from endpointer import PcmQueue, UtteranceEndpointer
from spend_governor import SKIP_MARKER, SpendGovernor
from tts_engine import TtsEngine
from vad import OutputGate


# ── mock vendors ─────────────────────────────────────────────────────


class MockStt:
    model = "mock_stt"

    def __init__(self, texts=None, error=None):
        self.texts = list(texts or [])
        self.error = error
        self.calls = []          # one entry per transcribe() — the audio it got

    async def transcribe(self, pcm):
        self.calls.append(np.asarray(pcm))
        if self.error:
            raise self.error
        return (self.texts.pop(0) if self.texts else "hello there"), 11.0


class MockTts:
    def __init__(self, model="mock_tts", error=None, chunks=None):
        self.model = model
        self.voice_settings = {"stability": 0.71, "similarity_boost": 0.91}
        self.error = error
        self.chunks = chunks
        self.calls = []          # one entry per stream() — the text it got

    async def stream(self, text):
        self.calls.append(text)
        if self.error:
            raise self.error
        for chunk in (self.chunks
                      if self.chunks is not None
                      else [np.full(2400, 0.3, dtype=np.float32)] * 2):
            yield chunk, 7.5


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


def utter(engine, n_speech=5, n_hangover=0, value=0.2):
    """Feed one complete utterance: speech hops, hangover hops, then gate close."""
    for _ in range(n_speech):
        engine.feed_hop(np.full(HOP, value, dtype=np.float32), True, True)
    for _ in range(n_hangover):
        engine.feed_hop(np.zeros(HOP, dtype=np.float32), True, False)
    engine.feed_hop(np.zeros(HOP, dtype=np.float32), False, False)


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


def test_exactly_one_stt_call_per_utterance():
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        for _ in range(3):
            utter(engine, n_speech=4)
        await wait_done(engine, 3)
        await engine.aclose()

    asyncio.run(run())
    assert len(stt.calls) == 3


def test_nothing_is_sent_while_the_gate_is_open():
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        for _ in range(40):        # a long open gate — over 5 seconds of speech
            engine.feed_hop(np.full(HOP, 0.2, dtype=np.float32), True, True)
        for _ in range(50):
            await asyncio.sleep(0.001)
        assert stt.calls == []     # not one byte left for the vendor
        engine.feed_hop(np.zeros(HOP, dtype=np.float32), False, False)
        await wait_done(engine, 1)
        await engine.aclose()

    asyncio.run(run())
    assert len(stt.calls) == 1


def test_hangover_audio_is_included_in_what_stt_receives():
    stt = MockStt()

    async def run():
        engine, _, _ = build(stt=stt)
        engine.start()
        utter(engine, n_speech=4, n_hangover=3)
        await wait_done(engine, 1)
        await engine.aclose()

    asyncio.run(run())
    assert len(stt.calls[0]) == 7 * HOP     # 4 speech + 3 hangover hops


def test_tail_latency_is_measured_from_the_end_of_SPEECH():
    """With 3 hangover hops (384 ms), even instant synthesis cannot beat 384 ms
    — because the clock starts when the human stopped talking."""
    async def run(n_hangover):
        engine, _, _ = build()
        engine.start()
        utter(engine, n_speech=4, n_hangover=n_hangover)
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
        utter(engine)
        await wait_done(engine, 1)
        utter(engine)
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
        utter(engine, n_speech=5)                  # 5 hops = 640 ms > 0.1 s
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
        utter(engine)
        await wait_done(engine, 1)
        utter(engine)
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
        utter(engine)
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
        utter(engine)
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
        utter(engine)
        await wait_done(engine, 1)
        engine.tts = good                          # vendor recovers
        utter(engine)
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
        utter(engine)
        await wait_done(engine, 1)
        await engine.aclose()
        return engine, notices

    engine, notices = asyncio.run(run())
    assert tts.calls == []
    assert engine.governor.tts_chars_used == 0
    assert notices[0]["reason"] == "empty_transcript"


def test_an_unexpected_error_does_not_kill_the_worker():
    class Exploding(MockStt):
        async def transcribe(self, pcm):
            raise RuntimeError("something nobody predicted")

    async def run():
        engine, _, _ = build(stt=Exploding())
        engine.start()
        utter(engine)
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
        utter(engine)
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
        utter(engine)
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
        utter(engine)
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
        utter(engine)
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
            utter(engine)
        await wait_done(engine, 3)
        await engine.aclose()
        return engine.latency_table()

    table = asyncio.run(run())
    assert set(table) == {"eleven_v3"}
    assert table["eleven_v3"]["n"] == 3
    for key in ("p50", "p95", "min", "max"):
        assert key in table["eleven_v3"]["tail_latency_ms"]
