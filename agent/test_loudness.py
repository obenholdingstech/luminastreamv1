"""Loudness-normalization tests.

The properties under test are the ones the ticket actually promises:
  1. an utterance comes out AT the target RMS (both boosted and attenuated),
  2. the make-up gain can NEVER clip — |output| stays under full scale for any
     input, however hot,
  3. silence and a disabled normalizer are exact pass-throughs (no surprise
     amplification of the noise floor; toggling off restores the raw signal),
  4. a near-silent utterance is not boosted past the max-gain guard.
"""

import numpy as np
import pytest

from loudness import (
    DEFAULT_CEILING_DB,
    LoudnessNormalizer,
    db_to_lin,
    lin_to_db,
    rms_dbfs,
    soft_limit,
)

CEILING = db_to_lin(DEFAULT_CEILING_DB)  # -1 dBFS ≈ 0.8913


def sine_at(db, n=4800, freq=220, sr=48000):
    """A sine whose RMS is exactly `db` dBFS."""
    t = np.arange(n) / sr
    amp = db_to_lin(db) * np.sqrt(2.0)          # sine RMS = amp/√2
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


# ── measurement ──────────────────────────────────────────────────────

def test_rms_dbfs_known_levels():
    assert rms_dbfs(np.full(1000, 0.5, dtype=np.float32)) == pytest.approx(-6.02, abs=0.05)
    assert rms_dbfs(sine_at(-20)) == pytest.approx(-20, abs=0.1)
    assert rms_dbfs(np.zeros(1000, dtype=np.float32)) <= -200   # silence → the floor
    assert rms_dbfs(np.zeros(0, dtype=np.float32)) <= -200      # empty → the floor


# ── it hits the target ───────────────────────────────────────────────

def test_boosts_quiet_utterance_to_target():
    norm = LoudnessNormalizer(target_db=-20.0)
    out, rep = norm.process(sine_at(-30))       # 10 dB too quiet, no peak issues
    assert rep["applied"] is True
    assert rep["gain_db"] == pytest.approx(10.0, abs=0.1)
    assert rms_dbfs(out) == pytest.approx(-20.0, abs=0.2)
    assert rep["limited"] is False


def test_attenuates_loud_utterance_to_target():
    norm = LoudnessNormalizer(target_db=-20.0)
    out, rep = norm.process(sine_at(-10))       # 10 dB too loud
    assert rep["gain_db"] == pytest.approx(-10.0, abs=0.1)
    assert rms_dbfs(out) == pytest.approx(-20.0, abs=0.2)


def test_length_is_preserved():
    norm = LoudnessNormalizer(target_db=-18.0)
    src = sine_at(-30, n=3333)
    out, _ = norm.process(src)
    assert len(out) == len(src)
    assert out.dtype == np.float32


# ── it never clips ───────────────────────────────────────────────────

def hot_signal():
    """Low RMS but spiky — forces a large make-up gain that overshoots peaks."""
    sig = np.full(4800, db_to_lin(-34) , dtype=np.float32)
    sig[100:140] = 0.5                          # sparse loud transients
    return sig


def test_make_up_gain_never_exceeds_full_scale():
    norm = LoudnessNormalizer(target_db=-6.0)   # aggressive target
    out, rep = norm.process(hot_signal())
    peak = float(np.max(np.abs(out)))
    assert rep["limited"] is True
    assert peak <= CEILING + 1e-6               # asymptotes to the ceiling…
    assert peak < 1.0                           # …which is under full scale → no clip


@pytest.mark.parametrize("target", [-30, -20, -12])
@pytest.mark.parametrize("seed", [0, 1, 2, 3])
def test_output_peak_under_full_scale_for_random_signals(target, seed):
    rng = np.random.default_rng(seed)
    sig = (rng.standard_normal(6000) * rng.uniform(0.01, 0.9)).astype(np.float32)
    out, _ = norm_process(target, sig)
    assert float(np.max(np.abs(out))) < 1.0


def norm_process(target, sig):
    return LoudnessNormalizer(target_db=target).process(sig)


# ── the soft limiter itself ──────────────────────────────────────────

def test_soft_limit_passes_below_knee_and_caps_above():
    knee, ceiling = 0.4, 0.9
    x = np.array([-0.3, 0.0, 0.35, 0.4, 2.0, -5.0, 100.0], dtype=np.float64)
    y = soft_limit(x, ceiling, knee)
    # below/at the knee: identity
    assert y[0] == pytest.approx(-0.3)
    assert y[2] == pytest.approx(0.35)
    assert y[3] == pytest.approx(0.4)
    # above the knee: compressed, sign preserved, strictly under the ceiling
    assert 0.4 < y[4] < ceiling
    assert -ceiling < y[5] < -0.4
    assert abs(y[6]) <= ceiling                 # saturates to the ceiling, never past
    assert np.all(np.abs(y) <= ceiling + 1e-9)


# ── pass-throughs: off / silence ─────────────────────────────────────

def test_disabled_is_exact_passthrough():
    src = sine_at(-30)
    out, rep = LoudnessNormalizer(target_db=-20.0, enabled=False).process(src)
    assert rep["applied"] is False
    np.testing.assert_array_equal(out, src)     # byte-identical → toggling off is safe


def test_silence_is_not_boosted():
    norm = LoudnessNormalizer(target_db=-20.0)
    quiet = sine_at(-70)                          # below the -60 dBFS silence floor
    out, rep = norm.process(quiet)
    assert rep["applied"] is False
    np.testing.assert_array_equal(out, quiet)


def test_empty_utterance_is_safe():
    out, rep = LoudnessNormalizer().process([])
    assert len(out) == 0
    assert rep["applied"] is False


# ── the max-gain guard ───────────────────────────────────────────────

def test_quiet_but_audible_utterance_is_capped_at_max_gain():
    # -55 dBFS is above the silence floor but 35 dB under the target; the guard
    # caps the boost at 30 dB so the noise floor is not dragged up with it.
    norm = LoudnessNormalizer(target_db=-20.0, max_gain_db=30.0)
    out, rep = norm.process(sine_at(-55))
    assert rep["applied"] is True
    assert rep["gain_db"] == pytest.approx(30.0, abs=0.01)
    assert rms_dbfs(out) == pytest.approx(-25.0, abs=0.3)  # -55 + 30, short of target


# ── list input (the engine hands over accumulated chunks) ────────────

def test_accepts_a_list_of_chunks():
    norm = LoudnessNormalizer(target_db=-20.0)
    whole = sine_at(-30, n=4800)
    as_chunks = [whole[i:i + 480] for i in range(0, len(whole), 480)]
    out_list, rep_list = norm.process(as_chunks)
    out_whole, _ = norm.process(whole)
    assert len(out_list) == len(whole)
    np.testing.assert_allclose(out_list, out_whole, atol=1e-6)


def test_report_fields_present():
    _, rep = LoudnessNormalizer(target_db=-18.0).process(sine_at(-28))
    assert set(rep) >= {"applied", "in_db", "gain_db", "out_db", "out_peak_db", "limited"}
    assert rep["in_db"] == pytest.approx(-28, abs=0.2)
    assert rep["out_peak_db"] <= DEFAULT_CEILING_DB + 0.5


def test_lin_db_roundtrip():
    for db in (-40, -20, -6, -1):
        assert lin_to_db(db_to_lin(db)) == pytest.approx(db, abs=1e-6)
