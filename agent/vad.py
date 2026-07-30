"""Silero VAD gate for the convert agent (Phase 3).

Non-speech audio (keyboard, doors, breaths) reaching RVC comes back as
hallucinated garble. This module gates the pipeline: only hops that contain
speech (plus a hangover tail) are sent to the RVC server; everything else
becomes clean silence on the output — with equal-power ramps at every gate
edge so transitions never click.

Verified against silero-vad 6.2.1 (pinned; installed in agent/.venv):
  - load_silero_vad(onnx=True) → OnnxWrapper (onnxruntime inference; the
    TorchScript path is avoided since Phase 3.1 — NNPACK log spam + CUDA
    wheel bloat on the VPS)
  - streaming contract: model(chunk, 16000) with chunks of EXACTLY 512
    samples @16 kHz (torch tensor — numpy rejected) returns a speech
    probability; the model keeps LSTM state across calls (reset_states())
  - VADIterator's default threshold is 0.5 — mirrored as our default
Our HOP is 6144 @48k = 128 ms → exactly 2048 @16k → exactly 4 model chunks
per hop, so the gate decision lands on hop boundaries by construction.

Pieces:
  Resampler48to16  stateful anti-aliased 3:1 decimator (VAD analysis only —
                   audio sent to RVC stays 48k)
  VadGate          per-hop speech decision: threshold + hangover; fail-open
                   (load or runtime failure ⇒ gate permanently open, one log)
  OutputGate       output-side state machine: drains the stitcher tail with a
                   fade-out at gate close, silence while closed, re-primes
                   with a fade-in at gate open; when the gate is always open
                   it reproduces the pre-Phase-3 priming/underrun behavior
"""

import logging
import math

import numpy as np
from scipy.signal import firwin, lfilter

from bridge import HOP

log = logging.getLogger("vad")

SR_IN = 48000
SR_VAD = 16000
DECIM = 3               # 48k → 16k
VAD_CHUNK = 512         # silero's required chunk size @16 kHz
DEFAULT_THRESHOLD = 0.5  # silero VADIterator default (verified 6.2.1)
DEFAULT_HANGOVER_MS = 300
RAMP_SAMPLES = 720      # 15 ms @48k equal-power edge ramp


class Resampler48to16:
    """Anti-aliased 3:1 decimator with filter state carried across calls.

    Chunked processing is bit-identical to one-shot processing (no boundary
    transients) as long as every chunk length is a multiple of 3 — true for
    both 480-sample frames and 6144-sample hops.
    """

    def __init__(self, taps=63):
        self._fir = firwin(taps, 7000, fs=SR_IN)  # cutoff under the 8 kHz Nyquist
        self._zi = np.zeros(taps - 1, dtype=np.float64)

    def process(self, x):
        x = np.asarray(x, dtype=np.float64)
        if len(x) % DECIM:
            raise ValueError("chunk length must be a multiple of 3")
        y, self._zi = lfilter(self._fir, 1.0, x, zi=self._zi)
        return y[::DECIM].astype(np.float32)


def load_silero_prob_fn():
    """Returns the real model's prob_fn. Raises on any failure.

    Phase 3.1: inference runs through onnxruntime (onnx=True) — the
    TorchScript path spammed NNPACK "unsupported hardware" warnings per conv
    on the VPS and forced CUDA-flavored torch wheels. torch itself remains
    imported: silero-vad imports it at module level and OnnxWrapper requires
    torch tensors (numpy input rejected with AttributeError .dim — verified
    live against 6.2.1), so it's pinned CPU-only in requirements instead.
    ONNX and JIT models return identical probabilities for the same input
    (spot-checked live: zero-chunk 0.00167 both; fox sentence 99% chunks
    ≥ 0.5 threshold).
    """
    import torch  # deferred: heavy import, and fail-open must catch it
    from silero_vad import load_silero_vad

    model = load_silero_vad(onnx=True)
    model.reset_states()

    def prob(chunk16):
        with torch.no_grad():
            return float(model(torch.from_numpy(chunk16), SR_VAD))

    return prob


class VadGate:
    """Per-hop speech gate: silero probability → threshold → hangover.

    decide_hop(hop48) → True (send to RVC) / False (gated). A hop is speech
    when the max chunk probability ≥ threshold; the gate then stays open for
    `hangover hops` after the last speech hop (hangover_ms rounded UP to whole
    hops — tail protection errs long, never short).

    Fail-open: if the model can't load or raises at runtime, the gate reports
    active=False and every decision is True (ungated — current behavior).
    One loud log; the agent additionally reports it over the data channel.
    """

    def __init__(self, threshold=DEFAULT_THRESHOLD, hangover_ms=DEFAULT_HANGOVER_MS,
                 hop=HOP, prob_fn=None):
        self.threshold = threshold
        self.hangover_ms = hangover_ms
        self.hop = hop
        self.hangover_hops = max(1, math.ceil(hangover_ms * SR_IN / 1000.0 / hop))
        self.active = False
        self.fail_reason = None
        self.gate_open = False
        self.last_prob = None
        self.hops_gated = 0
        self.hops_speech = 0
        self._hang_remaining = 0
        self._resampler = Resampler48to16()
        self._prob_fn = prob_fn
        if prob_fn is not None:
            self.active = True

    def set_threshold(self, threshold):
        self.threshold = float(threshold)

    def set_hangover_ms(self, hangover_ms):
        """Live retune; the hop-rounding rule matches __init__ exactly."""
        self.hangover_ms = float(hangover_ms)
        self.hangover_hops = max(1, math.ceil(self.hangover_ms * SR_IN / 1000.0 / self.hop))
        self._hang_remaining = min(self._hang_remaining, self.hangover_hops)

    def load(self):
        """Load the real silero model. Call before the room join (like RVC warmup)."""
        try:
            self._prob_fn = load_silero_prob_fn()
            self.active = True
        except Exception as exc:
            self._fail(f"model load failed: {exc!r}")
        return self

    def _fail(self, reason):
        if not self.active and self.fail_reason:
            return
        self.active = False
        self.fail_reason = reason
        self.gate_open = True  # fail-OPEN: everything passes, stream survives
        log.error("VAD DISABLED (%s) — continuing ungated, audio unaffected", reason)

    def decide_hop(self, hop48):
        """hop48: float32[hop] @48k — the newest hop of the assembler window."""
        if not self.active:
            return True
        try:
            chunk16 = self._resampler.process(np.asarray(hop48, dtype=np.float32))
            probs = [
                self._prob_fn(chunk16[i:i + VAD_CHUNK])
                for i in range(0, len(chunk16) - VAD_CHUNK + 1, VAD_CHUNK)
            ]
            self.last_prob = max(probs)
        except Exception as exc:
            self._fail(f"runtime error: {exc!r}")
            return True
        if self.last_prob >= self.threshold:
            self._hang_remaining = self.hangover_hops
            self.gate_open = True
            self.hops_speech += 1
            return True
        if self._hang_remaining > 0:
            self._hang_remaining -= 1
            self.gate_open = True
            return True
        self.gate_open = False
        self.hops_gated += 1
        return False


def _equal_power_in(n):
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)
    return np.sin(t) ** 2


COMFORT_OFF_DB = -80.0            # at/below this the bed is OFF (exact zeros)
COMFORT_GLIDE_SAMPLES = 1440     # ~30 ms crossfade at 48 kHz
_COMFORT_LPF_A = 0.05            # 1-pole low-pass coefficient (warm, not hiss)


class ComfortNoise:
    """A low-level shaped-noise 'room tone' mixed under gate-closed silence so
    conversational gaps don't feel like a dead line (CEO tuning-session finding).

    Additive with a gain that GLIDES to 0 while speech plays and to 1 during
    silence, so it crossfades at every utterance boundary rather than clicking
    in. The bed is 1-pole low-passed white noise (warm, not bright hiss),
    normalized to ~unit RMS and scaled by comfort_noise_db (dBFS). At/below
    COMFORT_OFF_DB the amplitude is exactly 0 — the pre-existing digital-zero
    behavior, so a disabled bed (and the whole RVC path) is byte-identical.

    A shaped-noise generator with an operator-tuned level was chosen over
    auto-deriving the level from recent TTS tails: auto-derive is fragile
    (breath/room bleed) and the console's whole method is tune-by-ear (see PR).
    """

    def __init__(self, db=None, glide_samples=COMFORT_GLIDE_SAMPLES, seed=1234):
        self._amp = 0.0
        self.db = None                   # last-set dBFS, for the applied snapshot
        self._gain = 0.0                 # current crossfade gain, 0..1
        self.glide = max(1, glide_samples)
        self._rng = np.random.default_rng(seed)
        self._lpf_zi = np.zeros(1, dtype=np.float64)
        # restore ~unit RMS after the 1-pole LPF attenuates white noise
        self._norm = float(np.sqrt((2.0 - _COMFORT_LPF_A) / _COMFORT_LPF_A))
        self.set_db(db)

    def set_db(self, db):
        self.db = db
        self._amp = 0.0 if (db is None or db <= COMFORT_OFF_DB) else float(10.0 ** (db / 20.0))

    @property
    def enabled(self):
        return self._amp > 0.0

    def mix(self, frame, speaking):
        """Add the bed to `frame` (in place-safe copy) and return it. `speaking`
        True ⇒ real audio is playing this frame (gain glides toward 0)."""
        if self._amp <= 0.0:
            return frame                 # off — untouched, exact zeros preserved
        n = len(frame)
        target = 0.0 if speaking else 1.0
        step = n / self.glide
        new_gain = (min(target, self._gain + step) if target > self._gain
                    else max(target, self._gain - step))
        env = np.linspace(self._gain, new_gain, n, dtype=np.float32)
        self._gain = new_gain
        white = self._rng.standard_normal(n)
        bed, self._lpf_zi = lfilter([_COMFORT_LPF_A], [1.0, -(1.0 - _COMFORT_LPF_A)],
                                    white, zi=self._lpf_zi)
        return frame + (bed.astype(np.float32) * self._norm * self._amp * env)


class OutputGate:
    """Output-side gating around the SolaStitcher.

    read_frame(n, gate_open) returns exactly n samples:
      - not primed → silence (priming threshold unchanged from Phase 1)
      - primed, buffer has n → normal read; a fade-in ramp is applied across
        the first RAMP_SAMPLES after each (re-)priming
      - primed, buffer short, gate CLOSED → drain whatever remains, fade it
        out to zero (equal-power), then pure silence; NOT an underrun — this
        silence is intentional. Sets `drained` for one call so the agent can
        mark in-flight windows stale and log/capture the event.
      - primed, buffer short, gate OPEN → the stitcher's whole-frame-silence
        underrun path, exactly as before Phase 3.

    With gate_open always True the behavior is identical to the pre-VAD agent.
    """

    def __init__(self, stitcher, prime_samples, ramp=RAMP_SAMPLES, comfort_noise_db=None):
        self.stitcher = stitcher
        self.prime_samples = prime_samples
        self.ramp = ramp
        self.primed = False
        self.drained = False   # one-shot flag: drain happened in the last read
        self._fade_pos = None  # sample position within an in-progress fade-in
        # Comfort-noise bed (tts only). None ⇒ off ⇒ exact digital zero, so the
        # RVC path (which never sets it) is byte-identical to before.
        self.comfort = ComfortNoise(comfort_noise_db) if comfort_noise_db is not None else None

    def set_comfort_noise_db(self, db):
        """Live retune of the comfort-noise bed (Phase 4 console)."""
        if self.comfort is None:
            self.comfort = ComfortNoise(db)
        else:
            self.comfort.set_db(db)

    def _bed(self, samples, speaking):
        """Mix the comfort-noise bed under `samples` (no-op when off/None)."""
        return samples if self.comfort is None else self.comfort.mix(samples, speaking)

    def reset(self):
        self.primed = False
        self.drained = False
        self._fade_pos = None

    def force_prime(self):
        """Prime now, regardless of buffer depth (TTS engine only).

        Additive for the spike's TTS mode; the RVC path never calls it and is
        unaffected. A synthesized utterance can legitimately be SHORTER than
        prime_samples ("yes."), and the normal rule would then never prime —
        leaving that audio stuck in the buffer to leak into the next utterance.
        The engine calls this once synthesis is complete, when no more audio is
        coming and whatever is buffered is all there will ever be.
        """
        if not self.primed:
            self.primed = True
            self._fade_pos = 0   # still ramp in — no click on the short one

    def _apply_fade_in(self, samples):
        if self._fade_pos is None or self._fade_pos >= self.ramp:
            return samples
        env = _equal_power_in(self.ramp)
        take = min(len(samples), self.ramp - self._fade_pos)
        samples[:take] *= env[self._fade_pos:self._fade_pos + take]
        self._fade_pos += take
        return samples

    def read_frame(self, n, gate_open):
        self.drained = False
        if not self.primed:
            if self.stitcher.available >= self.prime_samples:
                self.primed = True
                self._fade_pos = 0  # ramp in the fresh audio
            else:
                # pre-roll / between-utterance silence — the bed's home
                return self._bed(np.zeros(n, dtype=np.float32), speaking=False)
        if self.stitcher.available >= n:
            return self._bed(self._apply_fade_in(self.stitcher.read(n)), speaking=True)
        if gate_open:
            # true underrun (buffer starved mid-speech) — counted by the stitcher;
            # speaking context, so the bed stays faded out
            return self._bed(self.stitcher.read(n), speaking=True)
        # Gate closed and the tail is shorter than a frame: intentional drain
        tail = self.stitcher.drain(n)
        out = np.zeros(n, dtype=np.float32)
        if len(tail):
            ramp = min(self.ramp, len(tail))
            out[:len(tail)] = tail
            out[len(tail) - ramp:len(tail)] *= _equal_power_in(ramp)[::-1]
        self.primed = False
        self.drained = True
        # utterance ended — bed glides in under the fading tail (crossfade)
        return self._bed(out, speaking=False)
