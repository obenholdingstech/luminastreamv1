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
    dropouts = [(s, e) for s, e, c, _f in silences if c == "dropout"]
    benign = [(s, e) for s, e, c, _f in silences if c == "benign"]
    assert len(dropouts) == 1
    s, e = dropouts[0]
    assert s <= 4.0 and e >= 5.0  # the swallowed utterance is inside the flagged span
    assert benign  # leading/trailing true silence stays benign


def test_classify_silences_vad_gated_is_not_dropout():
    # Same lost 4–5s utterance, but a VAD gate-closed span covers it →
    # intentional suppression, not converter garble.
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3), (4.0, 5.0, 0.3)])
    env_out = synth_envelope(6, [(1.0, 3.0, 0.3)])
    silences = classify_silences(
        find_silence_regions(env_out), env_in, offset_frames=0,
        gated_spans=[(3.8, 5.5)],
    )
    cats = [c for _s, _e, c, _f in silences]
    assert "vad_gated" in cats
    assert "dropout" not in cats


def test_sparse_transients_in_gated_span_read_as_vad_gated():
    # Keyboard typing: only ~10% of envelope frames active — must still be
    # attributed to the VAD when the span is gate-closed, not called benign.
    env_in = synth_envelope(6, [(1.0, 3.0, 0.3)])
    for t in np.arange(3.3, 5.7, 0.1):          # sparse clicks ≈ 8% of frames,
        env_in[int(t * HOPS_PER_S)] = 0.25      # matching measured typing (9%)
    env_out = synth_envelope(6, [(1.0, 3.0, 0.3)])
    silences = classify_silences(
        find_silence_regions(env_out), env_in, offset_frames=0,
        gated_spans=[(3.2, 6.0)],
    )
    gated = [(s, e) for s, e, c, _f in silences if c == "vad_gated"]
    assert gated and gated[0][0] >= 3.0
    assert not [1 for _s, _e, c, _f in silences if c == "dropout"]


def test_gated_spans_from_events():
    from analyze_capture import gated_spans_from_events
    sr = 48000
    events = [
        {"event": "session", "in_pos": 0},
        {"event": "vad_gate", "state": "closed", "in_pos": 1 * sr},
        {"event": "vad_gate", "state": "open", "in_pos": 2 * sr},
        {"event": "vad_gate", "state": "closed", "in_pos": 5 * sr},  # never reopens
    ]
    spans = gated_spans_from_events(events)
    assert spans[0] == (1.0, 2.0)
    assert spans[1][0] == 5.0 and spans[1][1] == float("inf")


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


def test_stale_window_counted_exactly_once(tmp_path):
    """A window discarded as stale must not ALSO be reported as window_lost."""
    async def run():
        cap = SessionCapture(tmp_path, {"mode": "convert"}).start()
        cap.window_sent(1)
        await asyncio.sleep(0)
        cap.window_stale(1)                # came back, discarded as stale
        cap.window_sent(2)
        cap.window_stale(2, reason="mode")  # discarded because mode flipped
        await cap.aclose()
        return cap.session_dir

    session_dir = asyncio.run(run())
    events = [json.loads(line) for line in
              (session_dir / "meta.jsonl").read_text().splitlines()]
    stales = [e for e in events if e["event"] == "stale"]
    assert [e["seq"] for e in stales] == [1, 2]
    assert all(e.get("turnaround_ms") is not None for e in stales)
    assert stales[1]["reason"] == "mode"
    # exactly once: no window_lost, no window line for those seqs
    assert not [e for e in events if e["event"] in ("window", "window_lost")]


def test_capture_disables_when_writer_falls_behind(tmp_path):
    """Hitting the buffer bound frees memory and turns capture into no-ops."""
    async def run():
        cap = SessionCapture(tmp_path, {"mode": "convert"})  # writer never started
        cap.max_buffered_bytes = 10_000
        chunk = b"\x00" * 960
        for _ in range(20):
            cap.add_input(chunk)
        assert cap._dead is True
        assert cap._in_bufs == [] and cap._pending_bytes == 0
        before = cap.in_samples
        cap.add_input(chunk)       # all no-ops from here on
        cap.window_sent(9)
        cap.event("drop", seq=9)
        assert cap.in_samples == before and cap._pending == {}
        await cap.aclose()

    asyncio.run(run())


def test_capture_disables_on_writer_failure(tmp_path):
    """Writer task dying (unwritable dir) disables capture instead of leaking."""
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("file where the capture dir should go")

    async def run():
        cap = SessionCapture(blocker / "sub", {"mode": "convert"}).start()
        for _ in range(30):        # give the writer task a chance to fail
            if cap._dead:
                break
            await asyncio.sleep(0.05)
        assert cap._dead is True
        cap.add_input(b"\x00" * 960)
        assert cap._in_bufs == []  # no accumulation after death
        await cap.aclose()

    asyncio.run(run())
