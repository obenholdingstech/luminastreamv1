"""Phase 3 VAD gate tests — deterministic, no model download.

The silero model itself is swapped for a stub prob_fn keyed on chunk energy,
so every assertion is about OUR logic: resampler statefulness, threshold +
hangover, fail-open, and the full input-gate → stitcher → output-gate loop
(zeroed gated spans, hangover tail preservation, click-free edges, context
continuity across gates). The real model's contract (512-sample chunks @16k,
prob per chunk) was verified live against silero-vad 6.2.1 before this
design — see vad.py's docstring.
"""

import numpy as np
import pytest

from bridge import HOP, WINDOW, SolaStitcher, WindowAssembler
from vad import (
    DEFAULT_THRESHOLD,
    RAMP_SAMPLES,
    Resampler48to16,
    OutputGate,
    VadGate,
)

SR = 48000
FRAME = 480
HOP_MS = HOP * 1000 // SR  # 128


def energy_prob(chunk16):
    """Stub silero: 'speech' = SUSTAINED energy in the 16k chunk.

    The duty-cycle term mimics what real silero does for us: a short impulse
    (keyboard click, clap) has energy but no sustained voicing, so it scores 0.
    """
    rms = float(np.sqrt((chunk16 ** 2).mean()))
    duty = float((np.abs(chunk16) > 0.01).mean())
    return 1.0 if rms > 0.05 and duty > 0.5 else 0.0


def make_input(sections):
    """sections: list of (kind, seconds) with kind in speech|silence|clicks."""
    rng = np.random.default_rng(3)
    parts = []
    for kind, secs in sections:
        n = int(secs * SR)
        if kind == "speech":
            t = np.arange(n) / SR
            parts.append((0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32))
        elif kind == "clicks":
            x = np.zeros(n, dtype=np.float32)
            for start in range(2000, n - 200, 9600):  # a click every 200 ms
                x[start:start + 96] = rng.uniform(-0.8, 0.8, 96).astype(np.float32)
            parts.append(x)
        else:
            parts.append(np.zeros(n, dtype=np.float32))
    return np.concatenate(parts)


# ── resampler ────────────────────────────────────────────────────────


def test_resampler_chunked_equals_oneshot():
    t = np.arange(SR) / SR
    x = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
    whole = Resampler48to16().process(x)
    r = Resampler48to16()
    chunked = np.concatenate([r.process(x[i:i + FRAME]) for i in range(0, len(x), FRAME)])
    assert np.allclose(whole, chunked, atol=1e-6)  # stateful: no boundary transients
    assert len(whole) == len(x) // 3


def test_resampler_rejects_non_multiple_of_3():
    with pytest.raises(ValueError):
        Resampler48to16().process(np.zeros(100, dtype=np.float32))


# ── VadGate decisions ────────────────────────────────────────────────


def speech_hop():
    t = np.arange(HOP) / SR
    return (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silent_hop():
    return np.zeros(HOP, dtype=np.float32)


def test_gate_threshold_and_hangover():
    gate = VadGate(hangover_ms=300, prob_fn=energy_prob)
    assert gate.hangover_hops == 3  # 300ms rounds UP to 3 × 128ms hops
    assert gate.decide_hop(silent_hop()) is False   # starts closed
    assert gate.decide_hop(speech_hop()) is True    # opens on speech
    # hangover: exactly hangover_hops more silent hops stay open
    results = [gate.decide_hop(silent_hop()) for _ in range(5)]
    assert results == [True, True, True, False, False]
    assert gate.gate_open is False
    assert gate.hops_speech == 1


def test_gate_reopens_on_new_speech():
    gate = VadGate(prob_fn=energy_prob)
    gate.decide_hop(speech_hop())
    for _ in range(gate.hangover_hops + 1):
        gate.decide_hop(silent_hop())
    assert gate.gate_open is False
    assert gate.decide_hop(speech_hop()) is True
    assert gate.gate_open is True


def test_fail_open_on_runtime_error():
    def boom(_chunk):
        raise RuntimeError("model exploded")

    gate = VadGate(prob_fn=boom)
    assert gate.decide_hop(speech_hop()) is True   # fail-OPEN
    assert gate.active is False
    assert "model exploded" in gate.fail_reason
    assert gate.gate_open is True
    # subsequent hops all pass without re-raising
    assert all(gate.decide_hop(silent_hop()) for _ in range(3))


def test_fail_open_on_load_failure():
    gate = VadGate()
    gate._prob_fn = None
    gate._fail("model load failed: no torch")
    assert gate.active is False and gate.decide_hop(silent_hop()) is True


# ── the full gate loop: assembler → VadGate → echo-RVC → stitcher → OutputGate ──


def run_pipeline(x, vad, prime_samples=int(1.5 * HOP)):
    """Reference wiring of the convert path with an instant identity RVC.

    Returns (output, sent_windows: {seq: window}, gate_log: per-hop bool).
    """
    assembler = WindowAssembler()
    stitcher = SolaStitcher()
    outgate = OutputGate(stitcher, prime_samples)
    sent = {}
    gate_log = []
    out = np.zeros(0, dtype=np.float32)
    last_seq = 0
    for i in range(0, len(x) - FRAME + 1, FRAME):
        frame = x[i:i + FRAME]
        for seq, window in assembler.feed(frame):
            assert seq == last_seq + 1  # context accounting is gate-independent
            last_seq = seq
            send = vad.decide_hop(window[-HOP:]) if vad is not None else True
            gate_log.append(send)
            if send:
                sent[seq] = window.copy()
                stitcher.push(window)  # instant echo "conversion"
        gate_open = vad is None or not vad.active or vad.gate_open
        out = np.concatenate([out, outgate.read_frame(FRAME, gate_open)])
    return out, sent, gate_log


def test_gated_spans_are_zero_and_hangover_preserves_tail():
    x = make_input([("silence", 1.0), ("speech", 1.0), ("silence", 2.0),
                    ("clicks", 1.0), ("speech", 1.0), ("silence", 1.0)])
    vad = VadGate(hangover_ms=300, prob_fn=energy_prob)
    out, sent, gate_log = run_pipeline(x, vad)

    # clicks (impulses, low RMS per 32ms chunk) must be gated
    click_hops = range(int(4.0 * SR / HOP) + 1, int(5.0 * SR / HOP) - 1)
    assert not any(gate_log[h] for h in click_hops)

    # hangover: the hangover_hops after the last speech hop were still sent
    speech_end_hop = int(2.0 * SR / HOP)  # speech section ends at 2.0s
    for h in range(speech_end_hop + 1, speech_end_hop + 1 + vad.hangover_hops):
        assert gate_log[h - 1] or gate_log[h]  # boundary hop quantization slack

    # deep inside the gated stretch (well past hangover + drain) output is pure zero
    z0 = int(3.3 * SR)
    z1 = int(3.9 * SR)
    assert np.abs(out[z0:z1]).max() == 0.0

    # speech made it through (output non-zero somewhere in the speech span,
    # allowing for priming delay)
    s0, s1 = int(1.3 * SR), int(2.0 * SR)
    assert np.abs(out[s0:s1]).max() > 0.1


def test_no_step_discontinuities_at_gate_edges():
    x = make_input([("silence", 0.5), ("speech", 1.0), ("silence", 1.5),
                    ("speech", 1.0), ("silence", 1.0)])
    vad = VadGate(hangover_ms=300, prob_fn=energy_prob)
    out, _sent, _log = run_pipeline(x, vad)
    # 220 Hz sine at 0.5 amplitude: intrinsic max sample-to-sample step ≈ 0.0144.
    # A click at a gate edge would be an order of magnitude larger.
    max_jump = float(np.abs(np.diff(out)).max())
    assert max_jump < 0.05, f"gate edge click: max sample jump {max_jump:.3f}"


def test_context_continuity_across_gates():
    """The first window sent after gate-open must contain the gated-period
    audio as left context — gating affects SENDING only, never assembly."""
    x = make_input([("speech", 1.0), ("silence", 2.0), ("speech", 1.0)])
    vad = VadGate(hangover_ms=300, prob_fn=energy_prob)
    _out, sent, gate_log = run_pipeline(x, vad)

    closed = [i for i, g in enumerate(gate_log) if not g]
    assert closed, "gate never closed — fixture broken"
    reopen_seq = next(i for i in range(closed[0] + 1, len(gate_log)) if gate_log[i]) + 1
    window = sent[reopen_seq]
    hop_end = reopen_seq * HOP  # windows end exactly at hop boundaries
    expected = x[max(0, hop_end - WINDOW):hop_end]
    assert np.allclose(window[-len(expected):], expected), \
        "post-gate window lost acoustic context"


def test_fail_open_pipeline_equals_ungated():
    x = make_input([("speech", 0.5), ("clicks", 0.5), ("speech", 0.5)])

    def boom(_chunk):
        raise RuntimeError("dead model")

    out_failed, sent_failed, _ = run_pipeline(x, VadGate(prob_fn=boom))
    out_none, sent_none, _ = run_pipeline(x, None)
    assert sent_failed.keys() == sent_none.keys()  # everything sent — ungated
    assert np.array_equal(out_failed, out_none)


def test_outputgate_matches_legacy_when_gate_always_open():
    """gate_open=True forever ⇒ byte-identical to the pre-Phase-3 output path."""
    x = make_input([("speech", 2.0)])
    assembler, stitcher = WindowAssembler(), SolaStitcher()
    prime = int(1.5 * HOP)
    outgate = OutputGate(stitcher, prime)
    legacy_stitcher = SolaStitcher()
    legacy_primed = False
    new_out, legacy_out = [], []
    for i in range(0, len(x) - FRAME + 1, FRAME):
        frame = x[i:i + FRAME]
        for _seq, window in assembler.feed(frame):
            stitcher.push(window)
            legacy_stitcher.push(window)
        new_out.append(outgate.read_frame(FRAME, True))
        # pre-Phase-3 logic, verbatim
        if not legacy_primed and legacy_stitcher.available >= prime:
            legacy_primed = True
        if legacy_primed:
            legacy_out.append(legacy_stitcher.read(FRAME))
        else:
            legacy_out.append(np.zeros(FRAME, dtype=np.float32))
    new, old = np.concatenate(new_out), np.concatenate(legacy_out)
    # identical except the deliberate 15ms fade-in on the first primed samples
    fade_end = int(np.argmax(np.abs(old) > 0)) + RAMP_SAMPLES
    assert np.array_equal(new[fade_end:], old[fade_end:])
    assert legacy_stitcher.underrun_events == stitcher.underrun_events
