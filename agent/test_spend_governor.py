"""Spend-governor tests — the guardrail that lets this spike run unattended.

The property under test is not "it counts correctly" but "it cannot be talked
into spending more than the cap, and it never truncates an utterance to fit."
"""

import logging

import pytest

from spend_governor import (
    DEFAULT_MAX_STT_SECONDS,
    DEFAULT_MAX_TTS_CHARS,
    ENV_MAX_STT_SECONDS,
    ENV_MAX_STT_SECONDS_CEILING,
    ENV_MAX_TTS_CHARS,
    ENV_MAX_TTS_CHARS_CEILING,
    SKIP_MARKER,
    GovernorRefusal,
    SpendGovernor,
)


def gov(**kw):
    kw.setdefault("max_tts_chars", 100)
    kw.setdefault("max_stt_seconds", 10)
    return SpendGovernor(**kw)


# ── the cap actually caps ────────────────────────────────────────────


def test_spend_under_cap_passes():
    g = gov()
    g.reserve_tts(40)
    g.reserve_tts(60)
    assert g.tts_chars_used == 100
    assert g.tts_calls == 2


def test_exact_cap_is_allowed_one_over_is_not():
    g = gov()
    g.reserve_tts(100)
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(1)


def test_refusal_commits_nothing():
    """The whole point: a refused utterance must not move the meter."""
    g = gov()
    g.reserve_tts(90)
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(50)
    assert g.tts_chars_used == 90   # NOT 100, NOT 140 — untouched
    assert g.tts_calls == 1
    assert g.refusals == 1


def test_never_truncates_to_fit():
    """A 50-char utterance with 10 chars of headroom is skipped whole.

    There is deliberately no API to synthesize the affordable prefix — a
    half-spoken sentence is a corrupt result that mimics a pipeline bug.
    """
    g = gov()
    g.reserve_tts(90)
    with pytest.raises(GovernorRefusal) as ei:
        g.reserve_tts(50)
    assert ei.value.remaining == 10
    assert ei.value.requested == 50
    assert not hasattr(g, "reserve_tts_partial")


def test_short_utterance_still_fits_after_a_refusal():
    """A refusal is not a latch — the agent stays alive and keeps working."""
    g = gov()
    g.reserve_tts(95)
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(20)
    g.reserve_tts(5)                # fits in the remaining headroom
    assert g.tts_chars_used == 100
    assert g.refusals == 1


def test_meters_are_independent():
    g = gov()
    g.reserve_tts(100)
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(1)
    g.reserve_stt(5)                # STT budget untouched by TTS exhaustion
    assert g.stt_seconds_used == 5


def test_stt_seconds_cap():
    g = gov()
    g.reserve_stt(9.5)
    with pytest.raises(GovernorRefusal) as ei:
        g.reserve_stt(1.0)
    assert ei.value.meter == "stt_seconds"
    assert g.stt_seconds_used == 9.5


def test_zero_cap_refuses_everything():
    """A legitimate dry-run mode: caps of 0 make every billable call refuse."""
    g = SpendGovernor(max_tts_chars=0, max_stt_seconds=0)
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(1)
    with pytest.raises(GovernorRefusal):
        g.reserve_stt(0.1)
    g.reserve_tts(0)                # a zero-char utterance costs nothing


# ── refusals are unmistakable in the logs ────────────────────────────


def test_refusal_logs_the_fixed_marker_at_error(caplog):
    g = gov()
    with caplog.at_level(logging.ERROR, logger="governor"):
        with pytest.raises(GovernorRefusal):
            g.reserve_tts(500)
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelno == logging.ERROR
    assert SKIP_MARKER in record.getMessage()
    # the arithmetic travels with the marker so the log line is self-contained
    assert "500" in record.getMessage() and "100" in record.getMessage()


def test_refusal_payload_is_json_friendly():
    g = gov()
    with pytest.raises(GovernorRefusal) as ei:
        g.reserve_stt(999)
    assert ei.value.as_dict() == {
        "meter": "stt_seconds", "requested": 999.0,
        "used": 0.0, "cap": 10.0, "remaining": 10.0,
    }


# ── env overrides ────────────────────────────────────────────────────


def test_defaults_when_env_unset(monkeypatch):
    monkeypatch.delenv(ENV_MAX_TTS_CHARS, raising=False)
    monkeypatch.delenv(ENV_MAX_STT_SECONDS, raising=False)
    g = SpendGovernor()
    # DEV POSTURE (CEO, 6 Aug 2026): the defaults are effectively unlimited
    # for the development period — pinned here so a silent change back (or
    # further) is a red test, not a surprise mid-drill.
    assert g.max_tts_chars == DEFAULT_MAX_TTS_CHARS == 1_000_000_000
    assert g.max_stt_seconds == DEFAULT_MAX_STT_SECONDS == 100_000_000.0


def test_env_overrides_apply(monkeypatch):
    monkeypatch.setenv(ENV_MAX_TTS_CHARS, "250")
    monkeypatch.setenv(ENV_MAX_STT_SECONDS, "42.5")
    g = SpendGovernor()
    assert g.max_tts_chars == 250
    assert g.max_stt_seconds == 42.5


@pytest.mark.parametrize("bad", ["unlimited", "1e", "", "  ", "-1"])
def test_malformed_env_is_fatal_never_a_silent_default(monkeypatch, bad):
    """A guardrail that quietly falls back to a default is a rumor.

    Blank/whitespace are the exception: they read as 'unset' and take the
    default, which is the conservative direction.
    """
    monkeypatch.setenv(ENV_MAX_TTS_CHARS, bad)
    if bad.strip() == "":
        assert SpendGovernor().max_tts_chars == DEFAULT_MAX_TTS_CHARS
    else:
        with pytest.raises(SystemExit):
            SpendGovernor()


# ── reporting ────────────────────────────────────────────────────────


def test_snapshot_shape():
    g = gov()
    g.reserve_tts(30)
    g.reserve_stt(2.25)
    assert g.snapshot() == {
        "tts_chars_used": 30, "tts_chars_cap": 100, "tts_chars_ceiling": 100,
        "stt_seconds_used": 2.25, "stt_seconds_cap": 10.0, "stt_seconds_ceiling": 10.0,
        "tts_calls": 1, "stt_calls": 1, "refusals": 0,
    }


# ── two-layer caps: console knob, walled by an env-only ceiling ───────


def test_ceiling_defaults_to_the_starting_cap():
    # Without a ceiling override the wall sits AT the starting cap, so the
    # console can only ever LOWER spend — the guardrail is never widened.
    g = SpendGovernor(max_tts_chars=5000, max_stt_seconds=300)
    assert g.tts_chars_ceiling == 5000 and g.stt_seconds_ceiling == 300


def test_set_cap_lowers_freely_below_the_ceiling():
    g = SpendGovernor(max_tts_chars=5000, max_tts_chars_ceiling=5000)
    applied, adjusted = g.set_cap("tts_chars", 1200)
    assert applied == 1200 and adjusted is None
    assert g.max_tts_chars == 1200          # the live reservation limit moved


def test_set_cap_above_the_ceiling_clamps_and_reports():
    g = SpendGovernor(max_tts_chars=5000, max_tts_chars_ceiling=5000)
    applied, adjusted = g.set_cap("tts_chars", 999999)
    assert applied == 5000                  # the wall — client can never breach it
    assert adjusted == {"requested": 999999, "applied": 5000}
    assert g.max_tts_chars == 5000


def test_a_raised_env_ceiling_lets_the_console_go_higher():
    g = SpendGovernor(max_tts_chars=5000, max_tts_chars_ceiling=20000)
    applied, adjusted = g.set_cap("tts_chars", 12000)
    assert applied == 12000 and adjusted is None    # under the raised wall
    applied2, adjusted2 = g.set_cap("tts_chars", 25000)
    assert applied2 == 20000 and adjusted2["applied"] == 20000  # still walled


def test_set_cap_below_current_usage_is_allowed():
    # Clamping the budget below what is already spent is a valid "stop now"; the
    # cap moves and the next reservation refuses — no special-casing.
    g = SpendGovernor(max_tts_chars=5000, max_tts_chars_ceiling=5000)
    g.reserve_tts(4000)
    applied, adjusted = g.set_cap("tts_chars", 1000)
    assert applied == 1000 and adjusted is None
    with pytest.raises(GovernorRefusal):
        g.reserve_tts(1)                    # 4000 used already exceeds the new cap


def test_stt_cap_is_ceiling_walled_too():
    g = SpendGovernor(max_stt_seconds=300, max_stt_seconds_ceiling=300)
    applied, adjusted = g.set_cap("stt_seconds", 5000)
    assert applied == 300.0 and adjusted == {"requested": 5000.0, "applied": 300.0}


def test_a_starting_cap_above_its_ceiling_is_clamped_to_the_wall(caplog):
    # A misconfig (cap env > ceiling env) must NEVER widen the guardrail.
    g = SpendGovernor(max_tts_chars=9000, max_tts_chars_ceiling=3000)
    assert g.max_tts_chars == 3000 and g.tts_chars_ceiling == 3000


def test_ceiling_env_override(monkeypatch):
    monkeypatch.setenv(ENV_MAX_TTS_CHARS_CEILING, "20000")
    monkeypatch.setenv(ENV_MAX_STT_SECONDS_CEILING, "600")
    g = SpendGovernor(max_tts_chars=5000, max_stt_seconds=300)
    assert g.tts_chars_ceiling == 20000 and g.stt_seconds_ceiling == 600


def test_malformed_ceiling_env_is_fatal(monkeypatch):
    monkeypatch.setenv(ENV_MAX_TTS_CHARS_CEILING, "banana")
    with pytest.raises(SystemExit):
        SpendGovernor(max_tts_chars=5000)
