"""Unit tests for the Phase 1 diagnostics: analyze_capture math + capture writer.

All analysis inputs are synthetic — envelopes and waveforms built in-memory so
each detector's verdict is known by construction.
"""

import asyncio
import json
import wave

import numpy as np
import pytest

from analyze_capture import (
    ENV_HOP_MS,
    classify_silences,
    detect_tail_clips,
    detect_utterances,
    estimate_offset_ms,
    find_silence_regions,
    rms_envelope,
)
from capture import SessionCapture

HOPS_PER_S = int(1000 / ENV_HOP_MS)  # envelope frames per second


def synth_envelope(total_s, utterances, level=0.3, noise=1e-4):
    """Envelope with rectangular 'utterances' [(start_s, end_s, level), ...]."""
    env = np.full(int(total_s * HOPS_PER_S), noise, dtype=np.float32)
    for start, end, lvl in utterances:
        env[int(start * HOPS_PER_S):int(end * HOPS_PER_S)] = lvl
    return env


# ── offset estimation ────────────────────────────────────────────────


def test_offset_recovers_known_shift():
    env_in = synth_envelope(10, [(1, 2, 0.3), (4, 5.5, 0.4), (7, 7.4, 0.2)])
    shift = int(0.375 * HOPS_PER_S)  # 375 ms — the measured convert latency
    env_out = np.concatenate([np.full(shift, 1e-4, dtype=np.float32), env_in])[: len(env_in)]
    offset_ms, corr = estimate_offset_ms(env_in, env_out)
    assert offset_ms == pytest.approx(375, abs=ENV_HOP_MS)
    assert corr > 0.95


def test_offset_zero_for_passthrough():
    env = synth_envelope(10, [(1, 2, 0.3), (5, 6, 0.4)])
    offset_ms, corr = estimate_offset_ms(env, env.copy())
    assert offset_ms == 0.0
    assert corr > 0.99


# ── utterance segmentation ───────────────────────────────────────────


def test_detect_utterances_merges_short_gaps_and_drops_blips():
    env = synth_envelope(10, [
        (1.0, 2.0, 0.3),
        (2.1, 3.0, 0.3),    # 100ms gap < 250ms → merges with previous
        (5.0, 5.05, 0.3),   # 50ms blip < 150ms minimum → dropped
        (7.0, 8.0, 0.3),
    ])
    spans = detect_utterances(env)
    starts = [round(s / HOPS_PER_S, 2) for s, _ in spans]
    assert len(spans) == 2
    assert starts == [1.0, 7.0]


# ── the tail-clip detector (the point of this file) ──────────────────


def test_tail_clip_flagged_when_output_tail_missing():
    # Input: one 2s utterance. Output: same, but the last 300ms are gone —
    # the pipeline swallowed the end of the word.
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3)])
    env_out = synth_envelope(6, [(1.0, 2.7, 0.3)])
    utts = detect_utterances(env_in)
    res = detect_tail_clips(env_in, env_out, offset_frames=0, utterances=utts)
    assert len(res) == 1
    assert res[0]["clipped"] is True
    assert res[0]["body_ratio"] > 0.9  # body made it through fine


def test_intact_utterance_not_flagged():
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3)])
    utts = detect_utterances(env_in)
    res = detect_tail_clips(env_in, env_in.copy(), offset_frames=0, utterances=utts)
    assert len(res) == 1
    assert res[0]["clipped"] is False
    assert res[0]["tail_ratio"] == pytest.approx(1.0, rel=1e-3)


def test_whole_utterance_missing_is_dropout_not_tail_clip():
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3)])
    env_out = synth_envelope(6, [])  # nothing came out at all
    utts = detect_utterances(env_in)
    res = detect_tail_clips(env_in, env_out, offset_frames=0, utterances=utts)
    assert len(res) == 1
    assert res[0]["clipped"] is False  # body_ratio gate: starvation ≠ word clipping


def test_tail_clip_respects_alignment_offset():
    # Output delayed by 500ms with tail intact must NOT be flagged once the
    # offset is passed in.
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3)])
    off = int(0.5 * HOPS_PER_S)
    env_out = synth_envelope(6, [(1.5, 3.5, 0.3)])
    utts = detect_utterances(env_in)
    res = detect_tail_clips(env_in, env_out, offset_frames=off, utterances=utts)
    assert len(res) == 1
    assert res[0]["clipped"] is False


def test_tail_clip_skips_utterance_beyond_captured_output():
    env_in = synth_envelope(6, [(4.0, 5.9, 0.3)])
    env_out = synth_envelope(3, [])  # output capture ended before the utterance
    utts = detect_utterances(env_in)
    res = detect_tail_clips(env_in, env_out, offset_frames=0, utterances=utts)
    assert res == []  # unknowable ≠ clipped


# ── silence mapping + envelope ───────────────────────────────────────


def test_find_silence_regions():
    env = synth_envelope(6, [(0.0, 2.0, 0.3), (3.0, 6.0, 0.3)])
    regions = find_silence_regions(env)
    assert len(regions) == 1
    s, e = regions[0]
    assert s == pytest.approx(2.0, abs=0.05)
    assert e == pytest.approx(3.0, abs=0.05)


def test_classify_silences_benign_vs_dropout():
    # Input active 1–3s and 4–5s. Output lost the 4–5s utterance entirely.
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3), (4.0, 5.0, 0.3)])
    env_out = synth_envelope(6, [(1.0, 3.0, 0.3)])
    silences = classify_silences(find_silence_regions(env_out), env_in, offset_frames=0)
    dropouts = [(s, e) for s, e, d, _f in silences if d]
    benign = [(s, e) for s, e, d, _f in silences if not d]
    assert len(dropouts) == 1
    s, e = dropouts[0]
    assert s <= 4.0 and e >= 5.0  # the swallowed utterance is inside the flagged span
    assert benign  # leading/trailing true silence stays benign


def test_rms_envelope_values():
    sr = 48000
    x = np.concatenate([np.zeros(sr), 0.5 * np.ones(sr)]).astype(np.float32)
    env, hop = rms_envelope(x, sr=sr, hop_ms=10)
    assert hop == 480
    assert env[:99].max() == 0.0
    assert env[110:] == pytest.approx(0.5, rel=1e-3)


# ── capture writer: files land intact, hot-path is memory-only ───────


def test_session_capture_writes_valid_wavs_and_meta(tmp_path):
    async def run():
        cap = SessionCapture(tmp_path, {"mode": "passthrough", "hop": 6144}).start()
        tone = (np.sin(np.linspace(0, 100, 4800)) * 12000).astype(np.int16)
        cap.add_input(tone.tobytes())
        cap.add_output(tone.tobytes()[:4800])
        cap.window_sent(1)
        await asyncio.sleep(0)
        cap.window_recv(1)
        cap.window_sent(2)  # never returns → window_lost on close
        cap.event("drop", seq=3)
        await cap.aclose()
        return cap.session_dir

    session_dir = asyncio.run(run())

    with wave.open(str(session_dir / "input_48k.wav"), "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (48000, 1, 2)
        assert w.getnframes() == 4800
    with wave.open(str(session_dir / "output_48k.wav"), "rb") as w:
        assert w.getnframes() == 2400

    events = [json.loads(line) for line in
              (session_dir / "meta.jsonl").read_text().splitlines()]
    kinds = [e["event"] for e in events]
    assert kinds[0] == "session" and events[0]["mode"] == "passthrough"
    assert "drop" in kinds and "window_lost" in kinds and kinds[-1] == "session_end"
    win = next(e for e in events if e["event"] == "window")
    assert win["seq"] == 1 and win["turnaround_ms"] is not None
    lost = next(e for e in events if e["event"] == "window_lost")
    assert lost["seq"] == 2
    # every line carries the alignment keys
    assert all("in_pos" in e and "out_pos" in e for e in events)
