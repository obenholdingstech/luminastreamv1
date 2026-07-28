"""Endpointer and jitter-buffer tests — the input and output buffers of the
TTS engine, tested without any vendor or network in sight."""

import numpy as np

from bridge import HOP, SR
from endpointer import PcmQueue, Utterance, UtteranceEndpointer
from vad import OutputGate


def hop(value=0.1):
    return np.full(HOP, value, dtype=np.float32)


def speak(ep, n_speech, n_hangover=0, value=0.1):
    """Feed n_speech speech hops then n_hangover open-but-silent hops."""
    out = []
    for _ in range(n_speech):
        out.append(ep.feed_hop(hop(value), gate_open=True, is_speech=True))
    for _ in range(n_hangover):
        out.append(ep.feed_hop(hop(0.0), gate_open=True, is_speech=False))
    return out


# ── endpointing ──────────────────────────────────────────────────────


def test_nothing_emitted_while_the_gate_is_open():
    """The whole design: no partial uploads, so exactly one STT call per
    utterance is achievable at all."""
    ep = UtteranceEndpointer()
    assert all(u is None for u in speak(ep, 20))
    assert ep.utterances_emitted == 0
    assert ep.buffering


def test_one_utterance_per_gate_close():
    ep = UtteranceEndpointer()
    speak(ep, 5)
    utt = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert isinstance(utt, Utterance)
    assert ep.utterances_emitted == 1
    # the closing (gated) hop is NOT part of the utterance
    assert len(utt.pcm) == 5 * HOP
    # and a second closed hop does not emit a second, empty utterance
    assert ep.feed_hop(hop(), gate_open=False, is_speech=False) is None
    assert ep.utterances_emitted == 1


def test_hangover_audio_is_included_in_the_utterance():
    """Trailing consonants live in the hangover — Phase 3 exists so the
    pipeline never clips them, and STT must see them too."""
    ep = UtteranceEndpointer()
    speak(ep, 4, n_hangover=3)
    utt = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert len(utt.pcm) == 7 * HOP          # 4 speech + 3 hangover, all sent
    assert utt.n_speech_hops == 4
    assert utt.n_hangover_hops == 3


def test_hangover_is_excluded_from_the_latency_baseline():
    """...but the human stopped talking when the last SPEECH hop ended."""
    ep = UtteranceEndpointer()
    speak(ep, 4, n_hangover=3)
    utt = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert utt.hangover_s == 3 * HOP / SR
    assert utt.t_speech_end == utt.t_gate_close - utt.hangover_s
    # measuring from gate-close would under-report by exactly the hangover
    tail = utt.tail_latency_ms(utt.t_gate_close)
    assert abs(tail - utt.hangover_s * 1000) < 1e-6


def test_speech_after_hangover_resets_the_trailing_count():
    ep = UtteranceEndpointer()
    speak(ep, 2, n_hangover=2)
    speak(ep, 3)                            # speech resumed — same utterance
    utt = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert utt.n_speech_hops == 5
    assert utt.n_hangover_hops == 0         # last hop was speech
    assert len(utt.pcm) == 7 * HOP


def test_consecutive_utterances_are_independent():
    ep = UtteranceEndpointer()
    speak(ep, 3)
    first = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    speak(ep, 6)
    second = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert first.index == 1 and second.index == 2
    assert len(first.pcm) == 3 * HOP and len(second.pcm) == 6 * HOP


def test_blip_below_min_speech_is_dropped_without_an_stt_call():
    ep = UtteranceEndpointer(min_speech_ms=200)   # HOP is 128 ms → needs 2 hops
    speak(ep, 1)
    assert ep.feed_hop(hop(), gate_open=False, is_speech=False) is None
    assert ep.blips_dropped == 1
    assert ep.utterances_emitted == 0


def test_forced_cut_at_the_memory_bound_still_yields_the_audio():
    """A memory bound, deliberately distinct from a governor refusal: the
    audio is still transcribed rather than thrown away."""
    ep = UtteranceEndpointer(max_utterance_s=1.0)
    max_hops = ep.max_hops
    emitted = [u for u in speak(ep, max_hops) if u is not None]
    assert len(emitted) == 1
    assert emitted[0].reason == "max_length"
    assert ep.forced_cuts == 1


def test_reset_drops_a_half_buffered_utterance():
    ep = UtteranceEndpointer()
    speak(ep, 5)
    ep.reset()
    assert not ep.buffering
    assert ep.feed_hop(hop(), gate_open=False, is_speech=False) is None


def test_utterance_durations():
    ep = UtteranceEndpointer()
    speak(ep, 4, n_hangover=2)
    utt = ep.feed_hop(hop(), gate_open=False, is_speech=False)
    assert utt.duration_s == 6 * HOP / SR          # what STT bills for
    assert utt.speech_duration_s == 4 * HOP / SR
    assert utt.summary()["reason"] == "gate_close"


# ── PcmQueue: the output-side jitter buffer ──────────────────────────


def test_queue_is_sample_exact_and_contiguous():
    """No SOLA, no crossfade: what goes in comes out bit-for-bit, which is
    what makes 'no clicks at chunk boundaries' true by construction."""
    q = PcmQueue()
    ramp = np.linspace(-1, 1, 5000, dtype=np.float32)
    for off in range(0, len(ramp), 137):          # awkward, uneven chunks
        q.push(ramp[off:off + 137])
    out = np.concatenate([q.read(500) for _ in range(10)])
    assert np.array_equal(out, ramp)


def test_queue_read_across_chunk_boundaries_has_no_discontinuity():
    q = PcmQueue()
    t = np.arange(4800, dtype=np.float32)
    sine = np.sin(2 * np.pi * 440 * t / 48000).astype(np.float32)
    for off in range(0, len(sine), 331):
        q.push(sine[off:off + 331])
    out = np.concatenate([q.read(480) for _ in range(10)])
    # a pure 440 Hz sine's max sample-to-sample step is its derivative;
    # any splice artifact would show as a jump far above it
    assert np.max(np.abs(np.diff(out))) < 0.06


def test_queue_underrun_is_whole_frame_silence():
    q = PcmQueue()
    q.push(np.ones(100, dtype=np.float32))
    out = q.read(480)                              # short
    assert np.array_equal(out, np.zeros(480, dtype=np.float32))
    assert q.underrun_events == 1
    assert q.available == 100                      # the partial frame is kept


def test_queue_no_underrun_before_any_audio():
    """Matches SolaStitcher: silence before the first push is not an underrun."""
    q = PcmQueue()
    q.read(480)
    assert q.underrun_events == 0


def test_queue_drain_returns_what_exists():
    q = PcmQueue()
    q.push(np.ones(200, dtype=np.float32))
    assert len(q.drain(480)) == 200
    assert q.available == 0


def test_queue_exposes_the_solastitcher_surface_outputgate_uses():
    q = PcmQueue()
    for name in ("available", "read", "drain", "reset",
                 "underrun_events", "underrun_samples", "windows_stitched"):
        assert hasattr(q, name), name


# ── OutputGate over PcmQueue (reused unchanged from Phase 3) ─────────


def test_outputgate_primes_then_plays_out_the_queue():
    q = PcmQueue()
    gate = OutputGate(q, prime_samples=960)
    assert not np.any(gate.read_frame(480, True))   # not primed yet → silence
    q.push(np.full(1440, 0.5, dtype=np.float32))
    out = gate.read_frame(480, True)
    assert gate.primed and np.any(out)


def test_outputgate_force_prime_releases_a_too_short_utterance():
    """A synthesized 'yes.' can be shorter than the priming depth; without
    force_prime it would sit in the buffer forever and leak into the next one."""
    q = PcmQueue()
    gate = OutputGate(q, prime_samples=9216)
    q.push(np.full(2000, 0.5, dtype=np.float32))
    assert not np.any(gate.read_frame(480, True))   # never reaches the threshold
    gate.force_prime()
    assert np.any(gate.read_frame(480, False))
    assert gate.primed


def test_outputgate_drains_with_a_fade_at_end_of_utterance():
    q = PcmQueue()
    gate = OutputGate(q, prime_samples=480)
    q.push(np.full(700, 0.5, dtype=np.float32))
    gate.read_frame(480, True)
    out = gate.read_frame(480, False)               # 220 left, gate closed
    assert gate.drained
    assert out[-1] == 0.0                           # faded to zero, no click
    assert not gate.primed                          # re-primes for the next one
