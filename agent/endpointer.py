"""The two buffers that bracket the vendor round trip in TTS mode.

In RVC mode the Phase 3 VAD gate is a noise gate: speech hops go to the
converter, everything else becomes silence. In TTS mode the exact same gate
becomes an *utterance endpointer* — its open→closed transition is the signal
that a complete thought has been spoken and can be transcribed.

  UtteranceEndpointer  input side. Accumulates hops while the gate is open and
                       emits one Utterance at gate-close. Nothing leaves this
                       object while the gate is open, so there is exactly one
                       STT call per utterance and no partial uploads.
  PcmQueue             output side. A plain contiguous FIFO that presents the
                       same surface OutputGate/the stats loop already consume
                       from SolaStitcher, so the publisher and the output gate
                       are reused byte-for-byte.

Why PcmQueue instead of SolaStitcher: SOLA exists to splice OVERLAPPING
re-converted windows that share context, searching for the best phase
alignment between a new window and the tail already emitted. Synthesized TTS
audio is contiguous by construction — consecutive chunks are literally the
next samples of one waveform. Running SOLA over them would hunt for a
correlation peak that means nothing and crossfade a signal onto a shifted copy
of itself, i.e. manufacture comb filtering out of clean audio. So the buffer
swaps and everything downstream of it does not.

THE HANGOVER, TWICE OVER (both are deliberate and they are not in conflict):
  - the hangover audio IS included in the utterance sent to STT — trailing
    consonants live there, and Phase 3 exists precisely so the pipeline never
    becomes a word-clipper.
  - the hangover is NOT counted in tail_latency — the human stopped speaking
    when the last SPEECH hop ended, not when the gate finally closed. The
    endpointer records both instants so the metric measures the wait a person
    actually experiences.
"""

import logging
import time

import numpy as np

from bridge import HOP, SR

log = logging.getLogger("endpointer")

DEFAULT_MIN_SPEECH_MS = 200      # below this it is a blip, not an utterance
DEFAULT_MAX_UTTERANCE_S = 30.0   # memory bound for an unattended run


class Utterance:
    """One endpointed span of speech, plus the timing needed for tail_latency."""

    def __init__(self, index, pcm, n_speech_hops, n_hangover_hops,
                 t_gate_close, hop=HOP, sr=SR, reason="gate_close"):
        self.index = index
        self.pcm = pcm
        self.n_speech_hops = n_speech_hops
        self.n_hangover_hops = n_hangover_hops
        self.reason = reason                     # gate_close | max_length
        self.hop = hop
        self.sr = sr
        self.t_gate_close = t_gate_close
        self.hangover_s = n_hangover_hops * hop / sr
        # The instant the human actually stopped talking — the baseline the
        # spike's headline metric is measured from.
        self.t_speech_end = t_gate_close - self.hangover_s

    @property
    def duration_s(self):
        """Everything sent to STT, hangover included — what STT bills for."""
        return len(self.pcm) / self.sr

    @property
    def speech_duration_s(self):
        return self.n_speech_hops * self.hop / self.sr

    def tail_latency_ms(self, t_first_sample_enqueued):
        return (t_first_sample_enqueued - self.t_speech_end) * 1000.0

    def summary(self):
        return {
            "index": self.index,
            "duration_s": round(self.duration_s, 3),
            "speech_s": round(self.speech_duration_s, 3),
            "hangover_s": round(self.hangover_s, 3),
            "hops": self.n_speech_hops + self.n_hangover_hops,
            "reason": self.reason,
        }


class UtteranceEndpointer:
    """Gate-open→closed transitions become Utterances.

    feed_hop() takes the same per-hop decision the RVC path already computes
    (gate_open from VadGate.decide_hop, is_speech from the raw probability), so
    both engines endpoint on identical VAD behavior and the Phase 3/4 tuning
    knobs keep their meaning.
    """

    def __init__(self, hop=HOP, sr=SR, min_speech_ms=DEFAULT_MIN_SPEECH_MS,
                 max_utterance_s=DEFAULT_MAX_UTTERANCE_S):
        self.hop = hop
        self.sr = sr
        self.min_speech_ms = min_speech_ms
        self.max_utterance_s = max_utterance_s
        self.max_hops = max(1, int(max_utterance_s * sr / hop))
        self._hops = []
        self._n_speech = 0
        self._trailing_hangover = 0
        self._open = False
        self.utterances_emitted = 0
        self.blips_dropped = 0
        self.forced_cuts = 0

    @property
    def buffering(self):
        return bool(self._hops)

    def feed_hop(self, hop_pcm, gate_open, is_speech):
        """Returns an Utterance at gate-close, else None."""
        if gate_open:
            self._hops.append(np.asarray(hop_pcm, dtype=np.float32))
            if is_speech:
                self._n_speech += 1
                self._trailing_hangover = 0
            else:
                self._trailing_hangover += 1
            self._open = True
            if len(self._hops) >= self.max_hops:
                # Memory bound, NOT a spend decision: emit what we have so the
                # audio is still transcribed rather than thrown away.
                self.forced_cuts += 1
                log.warning("utterance exceeded %.0fs — cutting it here "
                            "(memory bound, not a spend cap)", self.max_utterance_s)
                return self._emit(reason="max_length")
            return None
        if self._open:
            self._open = False
            return self._emit()
        return None

    def _emit(self, reason="gate_close"):
        hops, n_speech = self._hops, self._n_speech
        trailing = self._trailing_hangover
        self._hops, self._n_speech, self._trailing_hangover = [], 0, 0
        if not hops:
            return None
        if n_speech * self.hop * 1000.0 / self.sr < self.min_speech_ms:
            # A blip, not an utterance. Dropping it here saves a vendor call
            # (and budget); distinct from a governor refusal on purpose.
            self.blips_dropped += 1
            log.info("dropping %d-hop blip (<%.0fms of speech) — no STT call",
                     len(hops), self.min_speech_ms)
            return None
        self.utterances_emitted += 1
        return Utterance(
            index=self.utterances_emitted,
            pcm=np.concatenate(hops),
            n_speech_hops=n_speech,
            n_hangover_hops=trailing,
            t_gate_close=time.monotonic(),
            hop=self.hop, sr=self.sr, reason=reason,
        )

    def reset(self):
        self._hops, self._n_speech, self._trailing_hangover = [], 0, 0
        self._open = False


class PcmQueue:
    """Contiguous 48 kHz mono FIFO — the TTS-mode jitter buffer.

    Deliberately API-compatible with the parts of SolaStitcher that OutputGate
    and the stats loop touch (available / read / drain / reset / underrun
    counters), so neither of them needs to know which engine is running.

    Unlike SolaStitcher there is no provisional tail to hold back: nothing will
    ever rewrite already-queued samples, so `available` is simply everything
    buffered. That also removes SolaStitcher's XFADE (1024 samples ≈ 21 ms) of
    structural output delay from the TTS path.
    """

    def __init__(self):
        self._buf = np.zeros(0, dtype=np.float32)
        self.chunks_pushed = 0
        self.samples_pushed = 0
        self.underrun_events = 0
        self.underrun_samples = 0

    @property
    def available(self):
        return len(self._buf)

    # SolaStitcher parity: the stats loop reads this to report buffer health
    @property
    def windows_stitched(self):
        return self.chunks_pushed

    def push(self, pcm):
        pcm = np.asarray(pcm, dtype=np.float32)
        if not len(pcm):
            return
        self._buf = np.concatenate([self._buf, pcm])
        self.chunks_pushed += 1
        self.samples_pushed += len(pcm)

    def read(self, n):
        """Exactly n samples; whole-frame silence + underrun count on shortfall.

        Whole-frame (never a partial splice) matches SolaStitcher so a starved
        TTS buffer degrades into clean silence rather than a click.
        """
        if self.available < n:
            if self.chunks_pushed > 0:
                self.underrun_events += 1
                self.underrun_samples += n
            return np.zeros(n, dtype=np.float32)
        out = self._buf[:n].copy()
        self._buf = self._buf[n:]
        return out

    def drain(self, n):
        """Up to n samples for an intentional end-of-utterance drain."""
        out = self._buf[:n].copy()
        self._buf = self._buf[n:]
        return out

    def reset(self):
        self._buf = np.zeros(0, dtype=np.float32)
