"""Unit tests for bridge.py — run: ./.venv/bin/python -m pytest test_bridge.py -q"""

import numpy as np
import pytest

from bridge import FRAME, HOP, SOLA, SR, WINDOW, XFADE, SolaStitcher, WindowAssembler


def frames_of(x, size=FRAME):
    for i in range(0, len(x) - size + 1, size):
        yield x[i:i + size]


# ── WindowAssembler ──────────────────────────────────────────────────


def test_assembler_bookkeeping():
    asm = WindowAssembler()
    x = np.arange(1, 5 * HOP + 1, dtype=np.float32)  # 1-based ramp: no 0 collisions
    got = []
    for f in frames_of(x):
        got.extend(asm.feed(f))

    # 5*HOP samples fed in 480-chunks → floor(5*6144/480)*480 = 30720 exactly
    assert [seq for seq, _ in got] == [1, 2, 3, 4, 5]
    assert all(len(w) == WINDOW for _, w in got)

    # Window 1: zero left pad + first HOP samples
    seq, w = got[0]
    pad = WINDOW - HOP
    assert np.all(w[:pad] == 0)
    np.testing.assert_array_equal(w[pad:], x[:HOP])

    # Window 3 ends at 3*HOP=18432 > WINDOW → no padding, pure slice
    _, w3 = got[2]
    np.testing.assert_array_equal(w3, x[3 * HOP - WINDOW:3 * HOP])

    # Consecutive windows share the same hop grid: last HOP of window k+1
    # continues exactly where window k ended
    _, w4 = got[3]
    np.testing.assert_array_equal(w4[-HOP:], x[3 * HOP:4 * HOP])


def test_assembler_partial_frames_and_leftover():
    asm = WindowAssembler()
    # 13 frames = 6240 samples → one window, 96 leftover
    x = np.random.default_rng(0).standard_normal(13 * FRAME).astype(np.float32)
    got = []
    for f in frames_of(x):
        got.extend(asm.feed(f))
    assert len(got) == 1
    # leftover 96 samples must appear at the start of the next window's fresh HOP
    got2 = asm.feed(np.ones(HOP, dtype=np.float32))
    assert len(got2) == 1
    _, w2 = got2[0]
    np.testing.assert_array_equal(w2[-HOP:-HOP + 96], x[-96:])


def test_assembler_seq_monotonic_across_reset():
    asm = WindowAssembler()
    asm.feed(np.zeros(2 * HOP, dtype=np.float32))
    assert asm.seq == 2
    asm.reset()
    got = asm.feed(np.ones(HOP, dtype=np.float32))
    assert [seq for seq, _ in got] == [3]
    # after reset the history is gone → zero-left-pad again
    _, w = got[0]
    assert np.all(w[:WINDOW - HOP] == 0)


# ── SolaStitcher ─────────────────────────────────────────────────────


def sine(n, freq=440.0, amp=0.5):
    return (amp * np.sin(2 * np.pi * freq * np.arange(n) / SR)).astype(np.float32)


def max_jump(x):
    return float(np.max(np.abs(np.diff(x)))) if len(x) > 1 else 0.0


def test_sine_chop_reassemble_no_phase_jumps():
    """Identity 'conversion': assembler → stitcher must reproduce the input."""
    x = sine(20 * HOP)
    asm, st = WindowAssembler(), SolaStitcher()
    for f in frames_of(x):
        for _seq, w in asm.feed(f):
            st.push(w)

    out = st.read(st.available)
    assert st.underrun_events == 0
    assert len(out) >= 18 * HOP

    # 440Hz/0.5amp sine: max per-sample step = amp*2π*440/48000 ≈ 0.0288.
    # Any splice discontinuity would exceed it by an order of magnitude.
    assert max_jump(out) < 0.04

    # Steady state must equal the source exactly (offsets land on the hop grid)
    np.testing.assert_allclose(out[:18 * HOP], x[:18 * HOP], atol=1e-4)


def test_sine_with_stretched_windows_stays_continuous():
    """~1.008 length ratio (observed from the real server) — SOLA absorbs it."""
    x = sine(20 * HOP)
    asm, st = WindowAssembler(), SolaStitcher()
    for f in frames_of(x):
        for _seq, w in asm.feed(f):
            n2 = int(round(len(w) * 1.008))
            stretched = np.interp(
                np.linspace(0, len(w) - 1, n2), np.arange(len(w)), w
            ).astype(np.float32)
            st.push(stretched)

    out = st.read(st.available)
    assert len(out) >= 18 * HOP
    # continuity is the claim here, not sample equality
    assert max_jump(out) < 0.06
    assert 0.3 < float(np.sqrt(np.mean(out ** 2))) < 0.4  # sine RMS ≈ 0.354


def test_underrun_behavior():
    st = SolaStitcher()
    # Reads before any window ever arrived are priming, not underruns
    silent = st.read(FRAME)
    assert np.all(silent == 0)
    assert st.underrun_events == 0

    st.push(np.ones(WINDOW, dtype=np.float32))
    assert st.available == HOP - XFADE  # provisional tail held back

    st.read(st.available)  # drain
    under = st.read(FRAME)
    assert np.all(under == 0)
    assert st.underrun_events == 1
    assert st.underrun_samples == FRAME

    # Next window replenishes; reads work again
    st.push(np.ones(WINDOW, dtype=np.float32))
    assert st.available > 0
    assert np.any(st.read(FRAME) != 0)


def test_underrun_read_does_not_consume_holdback():
    st = SolaStitcher()
    st.push(sine(WINDOW))
    st.read(st.available)
    before = st.available
    st.read(FRAME)  # underrun — must not eat into the XFADE holdback
    assert st.available == before


def test_varying_window_length_short_segment_bootstrap():
    """Windows shorter than XFADE+HOP fall back to append (no crash)."""
    st = SolaStitcher()
    st.push(np.ones(HOP // 2, dtype=np.float32))
    st.push(sine(WINDOW))
    st.push(sine(WINDOW))
    assert st.windows_stitched == 3
    assert st.available > 0


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-q"]))
