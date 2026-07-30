"""Per-utterance loudness normalization for the TTS engine — pure DSP, no I/O.

CEO tuning-session finding: request-continuity holds the *tone* across a
session, but the *volume sags* utterance to utterance, and ElevenLabs' Speaker
Boost is a similarity/clarity control, not a level control. This module levels
each synthesized utterance to a target loudness before it is enqueued, with a
soft limiter so the make-up gain can NEVER clip.

WHY RMS, NOT LUFS (the measurement decision the brief asked for, checked
against practice — ITU-R BS.1770-4 / EBU R128 and EBU Tech 3341/3342):

  Integrated LUFS is the right tool for PROGRAM-LENGTH material. It K-weights
  the signal, then mean-squares it over 400 ms blocks (75 % overlap) and
  applies a two-stage GATE — an absolute gate at -70 LUFS and a RELATIVE gate
  at -10 LU below the ungated loudness — to ignore silences. On a short
  utterance (often < 1-2 s of voiced audio after the VAD tail) there are only a
  handful of 400 ms blocks and the relative gate can discard most of them, so
  the integrated figure is unstable or undefined. That is exactly the regime
  the caller lives in, and it is why EBU defines Momentary (400 ms) and
  Short-term (3 s) meters for short content rather than reusing Integrated.

  And the problem here is the RELATIVE level of ONE voice across consecutive
  utterances. The source is a single ElevenLabs clone with a roughly stationary
  long-term spectrum, so K-weighting (LUFS's perceptual pre-filter, which earns
  its keep when comparing DIFFERENT spectra — a bright mix vs a bass-heavy one)
  buys almost nothing: the utterance-to-utterance differences the CEO hears are
  energy differences, which plain RMS captures directly.

  RMS is also exact at any length, needs no gating heuristics and no filter
  state across chunks, and is trivially unit-testable. K-weighted RMS
  (momentary-style, no gating) is the reasonable middle ground and could be
  swapped in behind `rms_dbfs()` later; it is not worth the extra filter here
  for a single stationary voice. Integrated LUFS is rejected for short-form.

THE SOFT LIMITER cannot be a hard clip: clipping a normalized peak injects
broadband harmonics that read as a click/crackle — the opposite of the polish
this ticket is for. Above a knee it compresses the excess along a tanh curve
that ASYMPTOTES to the ceiling, so the output magnitude approaches but never
reaches `ceiling` (< full scale) for any finite input. Below the knee the curve
is the identity (tanh'(0) = 1, C1-continuous at the knee), so ordinary
speech passes through untouched and only the loudest peaks are tamed — the
per-utterance leveling is preserved, not squashed.

All levels are dBFS relative to 1.0 full scale (a full-scale sine is -3 dBFS
RMS by this convention). Audio is float32 in [-1, 1] @ 48 kHz, matching the
TtsClient.stream() chunks and PcmQueue.
"""

import numpy as np

# Defaults (mirrored by the knobs registry — keep in sync with knobs.py).
DEFAULT_TARGET_DB = -20.0     # a natural speech RMS level; tune by ear per voice
DEFAULT_CEILING_DB = -1.0     # true-peak headroom the limiter asymptotes to
DEFAULT_KNEE_DB = 6.0         # soft-knee starts this far below the ceiling
DEFAULT_MAX_GAIN_DB = 30.0    # never boost a near-silent utterance more than this
DEFAULT_SILENCE_FLOOR_DB = -60.0  # below this an "utterance" is silence — leave it


def db_to_lin(db):
    return float(10.0 ** (db / 20.0))


def lin_to_db(lin):
    """dBFS of a linear amplitude; -inf-safe floor at a very small value."""
    return 20.0 * float(np.log10(max(float(lin), 1e-12)))


def rms_dbfs(x):
    """RMS of `x` (float array in [-1, 1]) as dBFS. Empty/silent → the floor
    (~-240 dBFS from lin_to_db's clamp), a finite JSON-safe 'as quiet as it
    gets' — well under any usable silence threshold."""
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return lin_to_db(0.0)
    return lin_to_db(np.sqrt(float(np.mean(x * x))))


def soft_limit(y, ceiling, knee_start):
    """Soft-knee peak limiter. |output| < `ceiling` for every finite input.

    Samples with |y| <= knee_start pass unchanged; above it the excess is
    compressed along a tanh that asymptotes to `ceiling`. C1-continuous at the
    knee (slope 1 on both sides), so there is no audible seam.
    """
    y = np.asarray(y, dtype=np.float64)
    span = max(ceiling - knee_start, 1e-9)
    mag = np.abs(y)
    over = mag > knee_start
    out = y.copy()
    if np.any(over):
        compressed = knee_start + span * np.tanh((mag[over] - knee_start) / span)
        out[over] = np.sign(y[over]) * compressed
    return out


class LoudnessNormalizer:
    """Levels a whole (short) utterance to `target_db` RMS, then soft-limits.

    Stateless across utterances by design — each utterance is measured and
    corrected on its own, which is the whole point (kill the drift between
    them). Live-tunable from the console: `enabled` and `target_db` are set by
    the apply path; a disabled normalizer is an exact pass-through so toggling
    it off restores the pre-normalization signal byte-for-byte.
    """

    def __init__(self, target_db=DEFAULT_TARGET_DB, enabled=True,
                 ceiling_db=DEFAULT_CEILING_DB, knee_db=DEFAULT_KNEE_DB,
                 max_gain_db=DEFAULT_MAX_GAIN_DB,
                 silence_floor_db=DEFAULT_SILENCE_FLOOR_DB):
        self.target_db = float(target_db)
        self.enabled = bool(enabled)
        self.ceiling = db_to_lin(ceiling_db)
        self.knee_start = db_to_lin(ceiling_db - knee_db)
        self.max_gain_db = float(max_gain_db)
        self.silence_floor_db = float(silence_floor_db)

    def set_target_db(self, db):
        self.target_db = float(db)

    def set_enabled(self, flag):
        self.enabled = bool(flag)

    def process(self, chunks):
        """Normalize an utterance. `chunks` is a float32 array OR a list of them
        (the engine accumulates the streamed synthesis chunks). Returns
        (out_float32, report). Length is always preserved.

        report = {applied, in_db, gain_db, out_db, out_peak_db, limited} — goes
        straight into the utterance capture record and the console panel so the
        leveling is evidence, not a black box.
        """
        if isinstance(chunks, (list, tuple)):
            audio = (np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])
                     if chunks else np.zeros(0, dtype=np.float32))
        else:
            audio = np.asarray(chunks, dtype=np.float32)

        in_db = rms_dbfs(audio)
        report = {"applied": False, "in_db": _round(in_db), "gain_db": 0.0,
                  "out_db": _round(in_db), "out_peak_db": _round(lin_to_db(_peak(audio))),
                  "limited": False}

        # Off, empty, or silence: pass through untouched. Boosting silence would
        # just amplify the noise floor / a stray breath into a roar.
        if not self.enabled or audio.size == 0 or in_db <= self.silence_floor_db:
            return audio, report

        # RMS make-up gain toward the target, clamped so a quiet utterance is
        # never boosted past max_gain_db (keeps the noise floor in check).
        gain_db = self.target_db - in_db
        gain_db = min(gain_db, self.max_gain_db)
        gained = audio.astype(np.float64) * db_to_lin(gain_db)

        limited = bool(np.any(np.abs(gained) > self.knee_start))
        out = soft_limit(gained, self.ceiling, self.knee_start) if limited else gained
        out = out.astype(np.float32)

        report.update({
            "applied": True,
            "gain_db": _round(gain_db),
            "out_db": _round(rms_dbfs(out)),
            "out_peak_db": _round(lin_to_db(_peak(out))),
            "limited": limited,
        })
        return out, report


def _peak(x):
    x = np.asarray(x)
    return float(np.max(np.abs(x))) if x.size else 0.0


def _round(db):
    """Round a dB figure for the record; -inf (silence) → None (JSON-safe)."""
    return None if db == float("-inf") else round(float(db), 2)
