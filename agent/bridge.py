"""Pure streaming logic for the RVC bridge (Move 2b) — no LiveKit, no network.

Extracted from the proven bridge_test_v3.py recipe (stateless sliding windows
@48k mono + SOLA-aligned equal-power crossfade). Two pieces:

  WindowAssembler  incoming 10ms frames → (seq, window[WINDOW]) every HOP samples
  SolaStitcher     converted windows → continuous output, readable in frames

The v3 offline reassembly rewrites the last XFADE samples of already-stitched
output on every new window, so the streaming stitcher holds back an XFADE-sized
provisional tail from readers (readable = stitched − XFADE).
"""

import numpy as np

SR = 48000        # WebRTC-native rate, matches AudioStream/AudioSource
FRAME = 480       # 10ms LiveKit delivery unit
HOP = 6144        # new audio per window (128 ms) — the latency knob
CTX = 8192        # left context re-converted each window (stateless server)
XFADE = 1024      # crossfade length
SOLA = 384        # phase-alignment search radius
SOLA_STRIDE = 8   # search step
WINDOW = CTX + HOP


class WindowAssembler:
    """Feed float32 frames of any length; emits (seq, window) every HOP new samples.

    Each window is the last WINDOW samples ending at the hop boundary,
    zero-left-padded while the stream is younger than WINDOW. seq starts at 1
    and stays monotonic across reset() — stale in-flight conversions from
    before a reset can then be discarded by seq alone.
    """

    def __init__(self, hop=HOP, window=WINDOW):
        if window < hop:
            raise ValueError("window must be >= hop")
        self.hop = hop
        self.window = window
        self.seq = 0  # last emitted seq
        self._buf = np.zeros(0, dtype=np.float32)
        self._since_hop = 0

    def feed(self, frame):
        """Returns a list of (seq, window) — 0 or more per call."""
        frame = np.asarray(frame, dtype=np.float32)
        self._buf = np.concatenate([self._buf, frame])
        self._since_hop += len(frame)
        out = []
        while self._since_hop >= self.hop:
            self._since_hop -= self.hop
            end = len(self._buf) - self._since_hop  # hop boundary
            win = self._buf[max(0, end - self.window):end]
            if len(win) < self.window:
                win = np.concatenate(
                    [np.zeros(self.window - len(win), dtype=np.float32), win]
                )
            self.seq += 1
            out.append((self.seq, win.copy()))
        # Keep only what future windows can still reach
        keep = self.window + self._since_hop
        if len(self._buf) > keep:
            self._buf = self._buf[-keep:]
        return out

    def reset(self):
        """Drop audio history (mode re-entry); seq keeps counting."""
        self._buf = np.zeros(0, dtype=np.float32)
        self._since_hop = 0


class SolaStitcher:
    """Streaming port of v3's SOLA reassembly.

    push() converted windows in ascending-seq order (caller enforces order and
    drop handling); read() pulls continuous output in arbitrary frame sizes.
    Converted window lengths may vary slightly (~1.008 ratio observed) — SOLA
    absorbs that. Underruns are whole-frame: a read that can't be fully
    satisfied returns pure silence (no mid-frame splice click) and is counted.
    """

    def __init__(self, hop=HOP, xfade=XFADE, sola=SOLA, stride=SOLA_STRIDE):
        self.hop = hop
        self.xfade = xfade
        self.sola = sola
        self.stride = stride
        t = np.linspace(0, np.pi / 2, xfade, dtype=np.float32)
        self._fin = np.sin(t) ** 2   # equal-power: fin + fout == 1
        self._fout = np.cos(t) ** 2
        self._buf = np.zeros(0, dtype=np.float32)  # stitched, not yet read
        self.windows_stitched = 0
        self.underrun_events = 0
        self.underrun_samples = 0

    @property
    def available(self):
        """Samples readable now — the provisional XFADE tail is held back."""
        return max(0, len(self._buf) - self.xfade)

    def push(self, window):
        window = np.asarray(window, dtype=np.float32)
        need = self.hop + self.xfade + 2 * self.sola
        seg = window[-need:] if len(window) >= need else window

        if len(self._buf) < self.xfade or len(seg) < self.xfade + self.hop:
            # Bootstrap (first window) or degenerate segment: append net-HOP tail
            tail = seg[-self.hop:] if len(seg) >= self.hop else seg
            self._buf = np.concatenate([self._buf, tail])
            self.windows_stitched += 1
            return

        ref = self._buf[-self.xfade:]
        max_off = min(2 * self.sola, len(seg) - self.xfade - self.hop)
        best_off, best_corr = 0, -1e18
        for off in range(0, max_off + 1, self.stride):
            cand = seg[off:off + self.xfade]
            corr = float(np.dot(ref, cand)) / (float(np.linalg.norm(cand)) + 1e-9)
            if corr > best_corr:
                best_corr, best_off = corr, off

        cand = seg[best_off:best_off + self.xfade]
        self._buf = np.concatenate([
            self._buf[:-self.xfade],
            ref * self._fout + cand * self._fin,
            seg[best_off + self.xfade: best_off + self.xfade + self.hop],
        ])
        self.windows_stitched += 1

    def read(self, n):
        """Exactly n samples; whole-frame silence + underrun count on shortfall."""
        if self.available < n:
            if self.windows_stitched > 0:
                self.underrun_events += 1
                self.underrun_samples += n
            return np.zeros(n, dtype=np.float32)
        out = self._buf[:n].copy()
        self._buf = self._buf[n:]
        return out

    def drain(self, n):
        """Up to n samples INCLUDING the provisional XFADE tail; no underrun count.

        For intentional end-of-stream drains (VAD gate close): no further window
        will rewrite the tail, so it is released as-is. Returns what exists —
        possibly fewer than n samples, possibly zero.
        """
        out = self._buf[:n].copy()
        self._buf = self._buf[n:]
        return out

    def reset(self):
        """Drop buffered output (mode re-entry); counters keep accumulating."""
        self._buf = np.zeros(0, dtype=np.float32)
