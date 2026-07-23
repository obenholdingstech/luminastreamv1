"""Silero VAD gate for the convert agent (Phase 3).

Non-speech audio (keyboard, doors, breaths) reaching RVC comes back as
hallucinated garble. This module gates the pipeline: only hops that contain
speech (plus a hangover tail) are sent to the RVC server; everything else
becomes clean silence on the output — with equal-power ramps at every gate
edge so transitions never click.

Verified against silero-vad 6.2.1 (pinned; installed in agent/.venv):
  - load_silero_vad(onnx=False) → TorchScript model
  - streaming contract: model(chunk, 16000) with chunks of EXACTLY 512
    samples @16 kHz returns a speech probability; the model keeps LSTM state
    across calls (reset_states() to clear)
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
    """Returns (prob_fn, describe) for the real model. Raises on any failure."""
    import torch  # deferred: heavy import, and fail-open must catch it
    from silero_vad import load_silero_vad

    model = load_silero_vad()
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

    def __init__(self, stitcher, prime_samples, ramp=RAMP_SAMPLES):
        self.stitcher = stitcher
        self.prime_samples = prime_samples
        self.ramp = ramp
        self.primed = False
        self.drained = False   # one-shot flag: drain happened in the last read
        self._fade_pos = None  # sample position within an in-progress fade-in

    def reset(self):
        self.primed = False
        self.drained = False
        self._fade_pos = None

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
                return np.zeros(n, dtype=np.float32)
        if self.stitcher.available >= n:
            return self._apply_fade_in(self.stitcher.read(n))
        if gate_open:
            return self.stitcher.read(n)  # true underrun — counted by the stitcher
        # Gate closed and the tail is shorter than a frame: intentional drain
        tail = self.stitcher.drain(n)
        out = np.zeros(n, dtype=np.float32)
        if len(tail):
            ramp = min(self.ramp, len(tail))
            out[:len(tail)] = tail
            out[len(tail) - ramp:len(tail)] *= _equal_power_in(ramp)[::-1]
        self.primed = False
        self.drained = True
        return out
