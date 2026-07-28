"""Preflight tests — the messages a VPS operator reads at 2am.

Amy deploys this by hand and hand-types two secrets into a file. The contract
under test is not "it detects bad config" but "it says what is wrong in a
sentence a human can act on, and never as a traceback".
"""

import asyncio
import json

import pytest

from elevenlabs_client import PreflightError, check_credentials, fetch_voice


# ── credentials, before any network call ─────────────────────────────


@pytest.mark.parametrize("key,voice,expected", [
    (None, "v1", "ELEVENLABS_API_KEY"),
    ("k1", None, "ELEVENLABS_VOICE_ID"),
    ("", "v1", "ELEVENLABS_API_KEY"),
    ("  ", "v1", "ELEVENLABS_API_KEY"),
])
def test_missing_credential_is_named_exactly(key, voice, expected):
    with pytest.raises(PreflightError) as ei:
        check_credentials(key, voice)
    msg = str(ei.value)
    assert expected in msg
    assert "secrets.env" in msg          # tells them WHERE to fix it


def test_both_missing_reads_as_one_sentence():
    with pytest.raises(PreflightError) as ei:
        check_credentials(None, None)
    msg = str(ei.value)
    assert "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are missing" in msg
    assert "them" in msg                 # grammatical in the plural case


def test_complete_credentials_pass_silently():
    assert check_credentials("k", "v") is None


# ── vendor responses → plain English ─────────────────────────────────


class FakeResponse:
    def __init__(self, status, body):
        self.status, self._body = status, body

    async def text(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, status, body):
        self._r = (status, body)

    def get(self, *a, **kw):
        return FakeResponse(*self._r)


def fetch(status, body):
    return asyncio.run(fetch_voice(FakeSession(status, body), "k", "the_voice"))


def test_bad_key_blames_the_key_not_the_voice():
    with pytest.raises(PreflightError) as ei:
        fetch(401, '{"detail":"unauthorized"}')
    msg = str(ei.value)
    assert "ELEVENLABS_API_KEY" in msg and "401" in msg
    assert "ELEVENLABS_VOICE_ID" not in msg


def test_unknown_voice_is_caught_on_a_400_not_only_a_404():
    """Verified live: an unknown voice returns 400 with a voice_not_found code,
    not the 404 you would expect. Matching only on 404 dumped raw JSON at the
    operator."""
    with pytest.raises(PreflightError) as ei:
        fetch(400, '{"detail":{"status":"voice_not_found","message":"..."}}')
    msg = str(ei.value)
    assert "ELEVENLABS_VOICE_ID" in msg and "the_voice" in msg
    assert "{" not in msg                # no raw JSON leaked into the message


def test_unknown_voice_on_a_real_404_too():
    with pytest.raises(PreflightError) as ei:
        fetch(404, "not found")
    assert "ELEVENLABS_VOICE_ID" in str(ei.value)


def test_network_failure_points_at_the_network():
    class Exploding:
        def get(self, *a, **kw):
            raise OSError("nodename nor servname provided")

    with pytest.raises(PreflightError) as ei:
        asyncio.run(fetch_voice(Exploding(), "k", "v"))
    assert "network" in str(ei.value).lower() or "reach" in str(ei.value).lower()


def test_a_healthy_voice_comes_back_intact():
    voice = fetch(200, json.dumps({"name": "Amy", "settings": {"stability": 0.7}}))
    assert voice["name"] == "Amy"


def test_preflight_errors_are_never_raw_exceptions():
    """Every failure path must produce PreflightError, which main() renders as
    a message. Anything else reaches the operator as a traceback."""
    for status, body in ((401, "{}"), (400, '{"status":"voice_not_found"}'),
                         (500, "boom"), (404, "")):
        with pytest.raises(PreflightError):
            fetch(status, body)
