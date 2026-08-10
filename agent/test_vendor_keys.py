"""The vendor keyring (10 Aug 2026): the pool behind ELEVENLABS_API_KEY.

Three layers pinned here: parsing/identity (the pool string is the whole
interface), the payment classifier (the ONLY thing allowed to trigger a
mid-run restart — transients must be unreachable), and the failover
behaviors themselves (pool preflight picks the first healthy key; the
engine restarts once on a payment-class refusal at either vendor).
"""

import asyncio

import pytest

import vendor_keys
from elevenlabs_client import PreflightError, SttError, TtsError
from test_tts_engine import MockStt, MockTts, build, utter, wait_done
from vendor_keys import (fingerprint, is_payment_class, is_stt_payment_class,
                         mask, parse_pool)


# ── parsing and identity ─────────────────────────────────────────────

def test_pool_parsing_single_key_is_a_pool_of_one():
    pool = parse_pool("sk_alpha")
    assert len(pool) == 1
    assert pool[0].api_key == "sk_alpha"
    assert pool[0].fingerprint == fingerprint("sk_alpha")


def test_pool_parsing_order_whitespace_and_dupes():
    pool = parse_pool("  sk_b , sk_a ,sk_b,, ")
    assert [c.api_key for c in pool] == ["sk_b", "sk_a"], "order kept, dupes and blanks dropped"


def test_pool_parsing_empty_shapes():
    assert parse_pool(None) == []
    assert parse_pool("") == []
    assert parse_pool(" , ,") == []


def test_fingerprint_is_stable_and_loggable():
    fp = fingerprint("sk_secret_value")
    assert fp == fingerprint("sk_secret_value"), "stable across calls"
    assert fp.startswith("k") and len(fp) == 9
    assert "sk_secret" not in fp, "never the key"


def test_mask_shows_only_the_tail():
    assert mask("sk_abcdefgh") == "…efgh"
    assert "sk_abcd" not in mask("sk_abcdefgh")


# ── the payment classifier: reachable ONLY by money refusals ─────────

def test_payment_class_fires_on_the_real_incident_shape():
    incident = TtsError('HTTP 401: {"detail":{"status":"payment_required",'
                        '"message":"Your subscription has a failed..."}}')
    assert is_payment_class(incident)
    assert is_payment_class(TtsError('HTTP 402: {"detail":{"status":"quota_exceeded"}}'))


def test_payment_class_is_unreachable_by_transients():
    for exc in (
        TtsError("HTTP 500: internal"),
        TtsError("HTTP 429: too many requests"),
        TtsError("HTTP 401: {\"detail\":\"invalid_api_key\"}"),  # bad key ≠ money
        TtsError("synthesis exceeded 30s"),
        TtsError("stream error: ClientConnectorError(...)"),
        # payment WORDS without the payment STATUS must not fire — the
        # status-prefix guard is load-bearing, not decorative
        TtsError("HTTP 503: payment provider maintenance window"),
        TtsError("HTTP 429: billing tier rate limit"),
        SttError("connection lost"),
    ):
        assert not is_payment_class(exc), str(exc)


def test_stt_payment_class_matches_vendor_vocabulary_only():
    assert is_stt_payment_class(SttError("auth_error: quota_exceeded"))
    assert is_stt_payment_class(SttError("payment_required"))
    assert not is_stt_payment_class(SttError("connection lost"))
    assert not is_stt_payment_class(SttError("timeout waiting for final"))


# ── the pool preflight: first healthy key wins ───────────────────────

def _pool_run(pool_value, listing_outcomes, build_outcomes=None):
    """Drive convert_agent._preflight_pool with fakes.

    listing_outcomes / build_outcomes map api_key → result or Exception.
    Returns (winner_key or None, error or None, attempts list).
    """
    import convert_agent

    attempts = []
    build_outcomes = build_outcomes or {}

    async def fake_list(http, api_key):
        attempts.append(api_key)
        out = listing_outcomes[api_key]
        if isinstance(out, Exception):
            raise out
        return out

    async def fake_build(args, http, api_key, startup_voice, voices, *rest):
        out = build_outcomes.get(api_key, ("http", "engine"))
        if isinstance(out, Exception):
            raise out
        return out

    async def main():
        real_list = convert_agent.list_voices_strict
        real_build = convert_agent._preflight_and_build
        convert_agent.list_voices_strict = fake_list
        convert_agent._preflight_and_build = fake_build
        try:
            return await convert_agent._preflight_pool(
                None, None, parse_pool(pool_value), "voice-x",
                None, [], {}, {})
        finally:
            convert_agent.list_voices_strict = real_list
            convert_agent._preflight_and_build = real_build

    try:
        result = asyncio.run(main())
        return result, None, attempts
    except PreflightError as exc:
        return None, exc, attempts


PREMADE = [{"voice_id": "premade-1", "name": "Rachel", "category": "premade"}]


def test_pool_dead_at_listing_falls_through_to_the_next_key():
    result, err, attempts = _pool_run(
        "sk_dead,sk_live",
        {"sk_dead": PreflightError("rejected (HTTP 401)"), "sk_live": PREMADE},
    )
    assert err is None and result == ("http", "engine")
    assert attempts == ["sk_dead", "sk_live"]


def test_pool_dead_at_warmup_falls_through_too():
    # The 9 Aug incident shape: listing PASSES, the spend gate refuses.
    result, err, attempts = _pool_run(
        "sk_broke,sk_live",
        {"sk_broke": PREMADE, "sk_live": PREMADE},
        {"sk_broke": PreflightError("TTS preflight synthesis failed: HTTP 401 payment_required")},
    )
    assert err is None and result == ("http", "engine")
    assert attempts == ["sk_broke", "sk_live"]


def test_pool_all_dead_names_every_account_without_leaking_keys():
    result, err, attempts = _pool_run(
        "sk_dead_one,sk_dead_two",
        {"sk_dead_one": PreflightError("reason one"),
         "sk_dead_two": PreflightError("reason two")},
    )
    assert result is None and err is not None
    msg = str(err)
    assert "reason one" in msg and "reason two" in msg
    assert fingerprint("sk_dead_one") in msg and fingerprint("sk_dead_two") in msg
    assert "sk_dead_one" not in msg and "sk_dead_two" not in msg, "keys never leak"


# ── startup-voice resolution per account ─────────────────────────────

def test_resolve_startup_voice_three_branches():
    from convert_agent import resolve_startup_voice

    listed = [{"voice_id": "clone-1", "name": "Me", "category": "cloned"},
              {"voice_id": "premade-1", "name": "Rachel", "category": "premade"}]
    assert resolve_startup_voice("clone-1", listed) == "clone-1", "configured wins when listed"
    assert resolve_startup_voice("foreign-clone", listed) == "premade-1", "fallback to premade"
    with pytest.raises(PreflightError):
        resolve_startup_voice("foreign-clone",
                              [{"voice_id": "c", "name": "c", "category": "cloned"}])


# ── mid-run failover: restart once, and only for money ───────────────

def _spyed(engine):
    calls = []
    engine._request_restart = lambda: calls.append(True)
    return calls


def test_payment_class_tts_error_requests_restart_once():
    async def main():
        tts = MockTts(error=TtsError('HTTP 401: {"detail":{"status":"quota_exceeded"}}'))
        engine, _, _ = build(tts=tts)
        calls = _spyed(engine)
        engine.start()
        await utter(engine)
        await asyncio.sleep(0.1)
        assert calls == [True], "exactly one restart request"
        assert engine.skipped >= 1, "the utterance was still dropped and logged"
        await engine.aclose()
    asyncio.run(main())


def test_stt_payment_class_requests_restart_too():
    async def main():
        stt = MockStt(error=SttError("auth_error: payment_required"), stream_fails=True)
        engine, _, _ = build(stt=stt)
        calls = _spyed(engine)
        engine.start()
        await utter(engine)
        await asyncio.sleep(0.1)
        assert calls == [True], "a dead account kills STT first — classified there too"
        await engine.aclose()
    asyncio.run(main())


def test_transient_errors_never_request_restart():
    async def main():
        for error in (TtsError("HTTP 500: internal"),
                      TtsError("HTTP 429: slow down"),
                      TtsError("stream error: ClientConnectorError"),
                      SttError("connection lost mid-stream")):
            if isinstance(error, TtsError):
                engine, _, _ = build(tts=MockTts(error=error))
            else:
                engine, _, _ = build(stt=MockStt(error=error, stream_fails=True))
            calls = _spyed(engine)
            engine.start()
            await utter(engine)
            await wait_done(engine, 1)
            assert calls == [], f"transient must never restart: {error}"
            await engine.aclose()
    asyncio.run(main())
