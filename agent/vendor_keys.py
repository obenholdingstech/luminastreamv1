"""The vendor keyring (CEO architecture, 10 Aug 2026).

`ELEVENLABS_API_KEY` stays the single interface everywhere; its VALUE is the
pool — an ordered, comma-separated key list where order IS preference and
membership IS the operator's liveness assertion (removing a dead account's
key is the explicit signal that its clones need healing; see the Worker's
voiceHeal). A single bare key is a pool of one: full back-compat.

Accounts are labeled by KEY FINGERPRINT — `k` + first 8 hex of sha256(key) —
which survives list reordering and is safe to log. The raw key appears in no
log line and no error message, ever.

This module is deliberately import-light (hashlib only) so it is unit-
testable without aiohttp and reusable by any future vendor pool (Decart
joins with a second account, same shape).
"""

import hashlib
from collections import namedtuple

Candidate = namedtuple("Candidate", ["fingerprint", "api_key"])


def fingerprint(api_key):
    """Stable, loggable identity for a key. Never reversible, never the key."""
    return "k" + hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:8]


def mask(api_key):
    """The only other form a key may take in text: its last four characters."""
    return "…" + api_key[-4:] if api_key else "(empty)"


def parse_pool(env_value):
    """The pool from the env value: ordered, de-duplicated, whitespace-tolerant.

    Returns [] for an absent/blank value — the CALLER decides whether an
    empty pool is fatal (the agent's preflight does, with the existing
    "missing from secrets.env" wording).
    """
    if not env_value:
        return []
    seen = set()
    pool = []
    for part in str(env_value).split(","):
        key = part.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        pool.append(Candidate(fingerprint(key), key))
    return pool


# ── payment-class classification ─────────────────────────────────────────
#
# The predicate that may trigger a mid-run failover restart. It must be
# UNREACHABLE by transient errors: timeouts, 429s, 5xx, and network noise
# carry no "HTTP 401/402 + billing marker" pair, so they can never match.
# The markers mirror the vendor's own wire vocabulary (the 9 Aug incident
# body read `{"detail":{"status":"payment_required",...}}`).

_PAYMENT_MARKERS = ("payment_required", "payment_issue", "quota_exceeded", "payment", "billing")


def is_payment_class(exc):
    """Is this TTS error the vendor refusing for MONEY reasons?"""
    text = str(exc).lower()
    if not (text.startswith("http 401") or text.startswith("http 402")):
        return False
    return any(marker in text for marker in _PAYMENT_MARKERS)


def is_stt_payment_class(exc):
    """The STT variant: WebSocket-framed errors carry no HTTP status line,
    so this matches on the vendor's own auth/billing vocabulary alone."""
    text = str(exc).lower()
    return any(marker in text for marker in (*_PAYMENT_MARKERS, "auth_error"))
