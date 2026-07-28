"""Hard per-run spend caps for the STT→TTS spike — the guardrail, written first.

ElevenLabs bills per synthesized character. This agent runs autonomously in a
loop against a real, funded account, so the ONLY acceptable design is one where
an unattended run is *physically unable* to drain it: every billable call goes
through a meter that refuses past a hard cap.

Two independent meters, both per-process-run (nothing persists across restarts):

  tts_chars    characters submitted for synthesis   SPIKE_MAX_TTS_CHARS   (5000)
  stt_seconds  seconds of audio submitted for STT   SPIKE_MAX_STT_SECONDS  (300)

SEMANTICS — read this before changing anything here:

1. The governor is FINANCIAL ONLY. It is not a quality knob, not a rate
   limiter, and it MUST NEVER truncate an utterance to fit the remaining
   budget. A half-spoken sentence is a corrupt experimental result that looks
   exactly like a pipeline bug. If an utterance does not fit, it is skipped
   WHOLE — the meter is left untouched and the caller drops that utterance.
2. A tripped governor must be UNMISTAKABLE. Refusals log at ERROR with the
   fixed marker `[governor] utterance skipped (would exceed cap)` and carry
   the arithmetic that produced them. Nothing else in this codebase logs that
   string, so "did we run out of budget or is the pipeline broken?" is always
   answerable by grep.
3. The agent STAYS ALIVE. A refusal is a `GovernorRefusal` raised at the
   reservation point, caught by the utterance worker, reported on the data
   channel, and then the next utterance is processed normally (it may well
   fit — a short one can pass after a long one was refused).

Caps are env-overridable for deliberate longer sessions. A malformed override
is fatal on purpose: silently falling back to a default is how a guardrail
becomes a rumor.
"""

import logging
import os

log = logging.getLogger("governor")

DEFAULT_MAX_TTS_CHARS = 5000
DEFAULT_MAX_STT_SECONDS = 300.0

ENV_MAX_TTS_CHARS = "SPIKE_MAX_TTS_CHARS"
ENV_MAX_STT_SECONDS = "SPIKE_MAX_STT_SECONDS"

# The one marker that means "we hit the money cap", never anything else
SKIP_MARKER = "[governor] utterance skipped (would exceed cap)"


class GovernorRefusal(Exception):
    """A billable call was refused because it would exceed a hard cap.

    Carries the full arithmetic so the log line, the data-channel message and
    the capture event all say the same thing without recomputing it.
    """

    def __init__(self, meter, unit, requested, used, cap):
        self.meter = meter          # "tts_chars" | "stt_seconds"
        self.unit = unit            # "chars" | "s"
        self.requested = requested
        self.used = used
        self.cap = cap
        self.remaining = max(0, cap - used)
        super().__init__(
            f"{meter}: need {requested}{unit}, only {self.remaining}{unit} left "
            f"of the {cap}{unit} cap (used {used}{unit})"
        )

    def as_dict(self):
        return {
            "meter": self.meter,
            "requested": self.requested,
            "used": self.used,
            "cap": self.cap,
            "remaining": self.remaining,
        }


def _env_number(name, default, cast):
    """Read a cap override. Malformed or negative ⇒ SystemExit, never a default."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = cast(raw.strip())
    except (TypeError, ValueError):
        raise SystemExit(
            f"{name}={raw!r} is not a valid number — refusing to start rather than "
            f"fall back to the default cap ({default}). Unset it or fix it."
        )
    if value < 0:
        raise SystemExit(f"{name}={raw!r} must be >= 0 (0 means 'refuse everything').")
    return value


class SpendGovernor:
    """Per-run meters for billable vendor calls.

    Usage is reserve-then-call: `reserve_tts(len(text))` commits the spend and
    returns, or raises `GovernorRefusal` having committed NOTHING. Reserving
    before the call (rather than recording after) means a crashed or hung
    vendor call still costs budget — the safe direction to be wrong in.
    """

    def __init__(self, max_tts_chars=None, max_stt_seconds=None):
        self.max_tts_chars = (
            _env_number(ENV_MAX_TTS_CHARS, DEFAULT_MAX_TTS_CHARS, int)
            if max_tts_chars is None else int(max_tts_chars)
        )
        self.max_stt_seconds = (
            _env_number(ENV_MAX_STT_SECONDS, DEFAULT_MAX_STT_SECONDS, float)
            if max_stt_seconds is None else float(max_stt_seconds)
        )
        self.tts_chars_used = 0
        self.stt_seconds_used = 0.0
        self.tts_calls = 0
        self.stt_calls = 0
        self.refusals = 0

    def log_startup(self):
        log.info(
            "spend caps for this run: TTS %d chars (%s), STT %.0f s (%s) — "
            "per-process, not persisted",
            self.max_tts_chars, ENV_MAX_TTS_CHARS,
            self.max_stt_seconds, ENV_MAX_STT_SECONDS,
        )

    # ── reservations ─────────────────────────────────────────────────

    def reserve_tts(self, chars):
        """Commit `chars` of synthesis budget, or raise GovernorRefusal.

        Never partially commits: the utterance is skipped whole, never trimmed
        to the remaining budget.
        """
        chars = int(chars)
        if chars < 0:
            raise ValueError("chars must be >= 0")
        if self.tts_chars_used + chars > self.max_tts_chars:
            self._refuse("tts_chars", "chars", chars,
                         self.tts_chars_used, self.max_tts_chars)
        self.tts_chars_used += chars
        self.tts_calls += 1

    def reserve_stt(self, seconds):
        """Commit `seconds` of transcription budget, or raise GovernorRefusal."""
        seconds = float(seconds)
        if seconds < 0:
            raise ValueError("seconds must be >= 0")
        if self.stt_seconds_used + seconds > self.max_stt_seconds:
            self._refuse("stt_seconds", "s", round(seconds, 2),
                         round(self.stt_seconds_used, 2), self.max_stt_seconds)
        self.stt_seconds_used += seconds
        self.stt_calls += 1

    def _refuse(self, meter, unit, requested, used, cap):
        self.refusals += 1
        refusal = GovernorRefusal(meter, unit, requested, used, cap)
        # ERROR, fixed marker, full arithmetic: a tripped cap must never be
        # mistaken for a pipeline fault while reading logs
        log.error("%s — %s", SKIP_MARKER, refusal)
        raise refusal

    # ── reporting ────────────────────────────────────────────────────

    def snapshot(self):
        """JSON-friendly meter state — goes into meta.jsonl and the final report."""
        return {
            "tts_chars_used": self.tts_chars_used,
            "tts_chars_cap": self.max_tts_chars,
            "stt_seconds_used": round(self.stt_seconds_used, 2),
            "stt_seconds_cap": self.max_stt_seconds,
            "tts_calls": self.tts_calls,
            "stt_calls": self.stt_calls,
            "refusals": self.refusals,
        }

    def summary_line(self):
        return (
            f"spend: TTS {self.tts_chars_used}/{self.max_tts_chars} chars "
            f"({self.tts_calls} calls) | STT {self.stt_seconds_used:.1f}/"
            f"{self.max_stt_seconds:.0f} s ({self.stt_calls} calls) | "
            f"refusals={self.refusals}"
        )
