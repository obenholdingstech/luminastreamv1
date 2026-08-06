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

TWO-LAYER CAPS (post-Stage-1 ticket 2) — read this, it reverses an earlier
ruling on purpose:

  Through #19 the caps were env-only with NO console control ("no sliders").
  The CEO now wants to adjust the session budget mid-drill without restarting
  the agent. So the cap becomes a console KNOB (tts_chars / stt_seconds) — but
  the financial guardrail is preserved by putting an env-only CEILING above it
  that the client can NEVER breach:

    ENV cap      (SPIKE_MAX_TTS_CHARS)          the STARTING session cap
    knob         (tts_chars)                    console-adjustable, live
    ENV ceiling  (SPIKE_MAX_TTS_CHARS_CEILING)  the WALL — env-only, immutable

  Any set is clamped to [0, ceiling] and reported with the same three-way
  disposition as every other knob (applied / adjusted / rejected). The ceiling
  DEFAULTS TO THE STARTING CAP, so without a deliberate ceiling override the
  console can only ever LOWER spend — an unattended run is still physically
  unable to spend more than today. Raising the budget is a conscious env act.

A malformed override (cap or ceiling) is fatal on purpose: silently falling
back to a default is how a guardrail becomes a rumor.
"""

import logging
import os

log = logging.getLogger("governor")

# DEV POSTURE (CEO directive, 6 Aug 2026): caps opened to effectively
# unlimited for the development period — the per-run budgets were cutting her
# own drills off mid-conversation (a refused reservation abandons the whole
# utterance, which reads as the converted voice going silent). ONLY THE
# NUMBERS MOVED: reserve-then-call, refusal, ceilings, and fatal-on-malformed
# env are all still armed, the startup line announces the posture, and env
# overrides still lower the caps without a deploy. The lens itself stays
# behind the admin gate, so this budget is reachable only logged-in.
# P5 (wallets) re-arms real numbers per user; these constants are the ones to
# change back if a bounded dev posture is ever wanted again.
DEV_UNLIMITED_TTS_CHARS = 1_000_000_000
DEV_UNLIMITED_STT_SECONDS = 100_000_000.0

DEFAULT_MAX_TTS_CHARS = DEV_UNLIMITED_TTS_CHARS
DEFAULT_MAX_STT_SECONDS = DEV_UNLIMITED_STT_SECONDS

ENV_MAX_TTS_CHARS = "SPIKE_MAX_TTS_CHARS"
ENV_MAX_STT_SECONDS = "SPIKE_MAX_STT_SECONDS"

# The wall: env-only absolute ceilings the console knob can never breach.
ENV_MAX_TTS_CHARS_CEILING = "SPIKE_MAX_TTS_CHARS_CEILING"
ENV_MAX_STT_SECONDS_CEILING = "SPIKE_MAX_STT_SECONDS_CEILING"

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

    def __init__(self, max_tts_chars=None, max_stt_seconds=None,
                 max_tts_chars_ceiling=None, max_stt_seconds_ceiling=None):
        self.max_tts_chars = (
            _env_number(ENV_MAX_TTS_CHARS, DEFAULT_MAX_TTS_CHARS, int)
            if max_tts_chars is None else int(max_tts_chars)
        )
        self.max_stt_seconds = (
            _env_number(ENV_MAX_STT_SECONDS, DEFAULT_MAX_STT_SECONDS, float)
            if max_stt_seconds is None else float(max_stt_seconds)
        )
        # The wall. Defaults to the starting cap, so an un-overridden ceiling
        # means the console can only lower spend, never raise it past today.
        self.tts_chars_ceiling = (
            _env_number(ENV_MAX_TTS_CHARS_CEILING, self.max_tts_chars, int)
            if max_tts_chars_ceiling is None else int(max_tts_chars_ceiling)
        )
        self.stt_seconds_ceiling = (
            _env_number(ENV_MAX_STT_SECONDS_CEILING, self.max_stt_seconds, float)
            if max_stt_seconds_ceiling is None else float(max_stt_seconds_ceiling)
        )
        # The wall always wins: a starting cap above its ceiling is clamped down
        # (a misconfig must never widen the guardrail).
        if self.max_tts_chars > self.tts_chars_ceiling:
            log.warning("%s (%d) exceeds its ceiling %s (%d) — clamped to the wall",
                        ENV_MAX_TTS_CHARS, self.max_tts_chars,
                        ENV_MAX_TTS_CHARS_CEILING, self.tts_chars_ceiling)
            self.max_tts_chars = self.tts_chars_ceiling
        if self.max_stt_seconds > self.stt_seconds_ceiling:
            log.warning("%s (%.0f) exceeds its ceiling %s (%.0f) — clamped to the wall",
                        ENV_MAX_STT_SECONDS, self.max_stt_seconds,
                        ENV_MAX_STT_SECONDS_CEILING, self.stt_seconds_ceiling)
            self.max_stt_seconds = self.stt_seconds_ceiling
        self.tts_chars_used = 0
        self.stt_seconds_used = 0.0
        self.tts_calls = 0
        self.stt_calls = 0
        self.refusals = 0

    def log_startup(self):
        if (self.max_tts_chars >= DEV_UNLIMITED_TTS_CHARS
                and self.max_stt_seconds >= DEV_UNLIMITED_STT_SECONDS):
            # The posture must be unmissable in the journal — an unlimited
            # governor that announces itself like a bounded one is how a dev
            # setting survives into a launch unnoticed.
            log.warning(
                "SPEND GOVERNOR: DEV-UNLIMITED (CEO, 6 Aug 2026) — caps are "
                "effectively off for the development period; machinery stays "
                "armed, env (%s / %s) can lower without a deploy, P5 wallets "
                "re-arm real numbers",
                ENV_MAX_TTS_CHARS, ENV_MAX_STT_SECONDS,
            )
            return
        log.info(
            "spend caps for this run: TTS %d/%d chars (cap/ceiling), STT %.0f/%.0f s "
            "(cap/ceiling) — cap is console-adjustable up to the env-only ceiling "
            "(%s / %s); per-process, not persisted",
            self.max_tts_chars, self.tts_chars_ceiling,
            self.max_stt_seconds, self.stt_seconds_ceiling,
            ENV_MAX_TTS_CHARS_CEILING, ENV_MAX_STT_SECONDS_CEILING,
        )

    # ── live cap control (console knob, walled by the env ceiling) ────

    def set_cap(self, meter, value):
        """Live-adjust a session cap, clamped to its env ceiling — the wall the
        client can NEVER breach. `meter` is "tts_chars" or "stt_seconds".

        Returns (applied, adjusted_or_None): adjusted = {"requested","applied"}
        when the request was clamped to the ceiling (or up to 0), else None.
        Lowering below current usage is allowed — it simply refuses sooner; the
        ceiling is the only hard upper bound.
        """
        if meter == "tts_chars":
            requested = int(value)
            applied = max(0, min(requested, self.tts_chars_ceiling))
            self.max_tts_chars = applied
        elif meter == "stt_seconds":
            requested = float(value)
            applied = max(0.0, min(requested, self.stt_seconds_ceiling))
            self.max_stt_seconds = applied
        else:
            raise ValueError(f"unknown meter {meter!r}")
        adjusted = None if applied == requested else {"requested": requested,
                                                      "applied": applied}
        return applied, adjusted

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
            "tts_chars_ceiling": self.tts_chars_ceiling,
            "stt_seconds_used": round(self.stt_seconds_used, 2),
            "stt_seconds_cap": self.max_stt_seconds,
            "stt_seconds_ceiling": self.stt_seconds_ceiling,
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
