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
    ENV_MAX_TTS_CHARS,
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
    assert g.max_tts_chars == DEFAULT_MAX_TTS_CHARS == 5000
    assert g.max_stt_seconds == DEFAULT_MAX_STT_SECONDS == 300


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
        "tts_chars_used": 30, "tts_chars_cap": 100,
        "stt_seconds_used": 2.25, "stt_seconds_cap": 10.0,
        "tts_calls": 1, "stt_calls": 1, "refusals": 0,
    }
