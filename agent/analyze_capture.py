"""Offline analysis of a convert-agent capture session (Phase 1 diagnostics).

Takes a session directory written by `convert_agent.py --capture-dir` (see
capture.py: input_48k.wav + output_48k.wav + meta.jsonl) and produces, inside
that directory:

  aligned_waveforms.png  input vs output with the latency offset removed
                         (offset computed via RMS-envelope cross-correlation,
                         reported in ms)
  spectrograms.png       input/output spectrogram pair on a shared dB scale —
                         this is where "chunky gibberish" becomes visible
  rms_envelope.png       RMS envelope overlay with utterance segmentation and
                         tail-clip flags (input tail energy with no
                         corresponding output tail = the word-clipping
                         detector)
  dropout_map.png        output-timeline silence regions annotated with
                         meta.jsonl events — three attributions: benign
                         (input silent too), VAD-gated (intentional — inside
                         a gate-closed span), and DROPOUT (drops/underruns
                         nearby = starvation; no events = converter garble)
  report.txt             text summary of all of the above

TEST PROTOCOL
=============
1. Start the RVC end (mock on the Mac: `./.venv/bin/python mock_rvc_server.py`).
2. Start the agent with capture:
     ./.venv/bin/python convert_agent.py --capture-dir captures/
3. Connect from /livekit-test (or a scripted publisher) and record the probe:
   speak **"the quick brown fox jumps over the lazy dog"**, then ~3 s of
   **keyboard typing** (broadband transients — shows smearing/garbling that
   vowels hide). Disconnect to close the session.
4. Repeat in BOTH modes (passthrough and convert) — one session each.
5. Analyze each session:
     ./.venv/bin/python analyze_capture.py captures/<timestamp>/
Expected latency offset: ~0 ms in passthrough; roughly hop (128 ms) +
turnaround (~80 ms) + jitter buffer (~170 ms) ≈ 375 ms in convert mode.

Pure-math helpers (rms_envelope, estimate_offset_ms, detect_utterances,
detect_tail_clips, find_silence_regions) have no I/O and are unit-tested in
test_analyze.py.
"""

import argparse
import json
import sys
import wave
from pathlib import Path

import numpy as np

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SR = 48000
ENV_HOP_MS = 10.0          # RMS envelope resolution
MAX_LAG_MS = 2000.0        # cross-correlation search range
UTTER_THRESH_RATIO = 0.10  # utterance gate: fraction of 95th-percentile RMS
UTTER_MIN_MS = 150.0       # shorter active spans are ignored
UTTER_GAP_MS = 250.0       # gaps shorter than this merge two spans
TAIL_MS = 250.0            # utterance tail examined by the clip detector
TAIL_RATIO = 0.25          # output tail below this fraction of input ⇒ clipped
BODY_RATIO = 0.30          # body must have made it through, else it's a dropout
SILENCE_MIN_MS = 120.0     # minimum output silence span worth mapping

# dataviz palette (light surface) — input blue, output orange, fixed assignment
C_IN = "#2a78d6"
C_OUT = "#eb6834"
C_CRIT = "#d03b3b"     # drops / flagged tail clips
C_WARN = "#c98500"     # underruns
C_MUTE = "#52514e"
SURFACE = "#fcfcfb"

plt.rcParams.update({
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "text.color": "#0b0b0b",
    "axes.labelcolor": C_MUTE,
    "xtick.color": C_MUTE,
    "ytick.color": C_MUTE,
    "axes.edgecolor": "#d8d7d2",
    "axes.grid": True,
    "grid.color": "#eceae5",
    "grid.linewidth": 0.6,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "font.size": 9,
})


# ── pure math (unit-tested) ──────────────────────────────────────────


def rms_envelope(x, sr=SR, hop_ms=ENV_HOP_MS):
    """Per-hop RMS of x. Returns (envelope, hop_samples)."""
    hop = max(1, int(round(sr * hop_ms / 1000.0)))
    n = len(x) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32), hop
    frames = x[: n * hop].reshape(n, hop).astype(np.float64)
    return np.sqrt((frames ** 2).mean(axis=1)).astype(np.float32), hop


def estimate_offset_ms(env_in, env_out, hop_ms=ENV_HOP_MS, max_lag_ms=MAX_LAG_MS):
    """Latency of output vs input via envelope cross-correlation.

    Positive = output lags input. Returns (offset_ms, peak_corr) where
    peak_corr is the normalized correlation coefficient at the best lag
    (≈1.0 when the envelopes really are shifted copies).
    """
    n = min(len(env_in), len(env_out))
    if n < 4:
        return 0.0, 0.0
    a = env_in[:n].astype(np.float64)
    b = env_out[:n].astype(np.float64)
    a -= a.mean()
    b -= b.mean()
    max_lag = min(n - 1, int(round(max_lag_ms / hop_ms)))
    lags = np.arange(0, max_lag + 1)  # output only ever lags the input
    best_lag, best = 0, -np.inf
    for lag in lags:
        aa, bb = a[: n - lag], b[lag:]
        denom = np.linalg.norm(aa) * np.linalg.norm(bb)
        corr = float(np.dot(aa, bb) / denom) if denom > 0 else 0.0
        if corr > best:
            best, best_lag = corr, lag
    return best_lag * hop_ms, best


def detect_utterances(env, hop_ms=ENV_HOP_MS, thresh_ratio=UTTER_THRESH_RATIO,
                      min_ms=UTTER_MIN_MS, gap_ms=UTTER_GAP_MS):
    """Active spans of an RMS envelope → list of (start_idx, end_idx) frames.

    Threshold is relative to the 95th percentile so mic gain doesn't matter;
    spans separated by less than gap_ms merge; spans shorter than min_ms drop.
    """
    if len(env) == 0:
        return []
    ref = float(np.percentile(env, 95))
    if ref <= 0:
        return []
    active = env >= ref * thresh_ratio
    spans = []
    start = None
    for i, on in enumerate(active):
        if on and start is None:
            start = i
        elif not on and start is not None:
            spans.append([start, i])
            start = None
    if start is not None:
        spans.append([start, len(env)])
    merged = []
    max_gap = int(round(gap_ms / hop_ms))
    for s in spans:
        if merged and s[0] - merged[-1][1] <= max_gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    min_len = int(round(min_ms / hop_ms))
    return [(s, e) for s, e in merged if e - s >= min_len]


def detect_tail_clips(env_in, env_out, offset_frames, utterances,
                      hop_ms=ENV_HOP_MS, tail_ms=TAIL_MS,
                      tail_ratio=TAIL_RATIO, body_ratio=BODY_RATIO):
    """The word-clipping detector.

    For each input utterance, compare tail energy (last tail_ms) against the
    aligned output. Flagged when the utterance body DID come through
    (body energy ≥ body_ratio of input) but the tail did not (tail energy
    < tail_ratio of input) — i.e. the pipeline swallowed the end of a word.
    Whole-utterance losses are dropouts, not tail clips, and are not flagged
    here. Returns a list of dicts with per-utterance ratios and a "clipped"
    flag.
    """
    results = []
    tail_frames = max(1, int(round(tail_ms / hop_ms)))
    for start, end in utterances:
        tail_start = max(start, end - tail_frames)
        o_start, o_end = start + offset_frames, end + offset_frames
        o_tail_start = tail_start + offset_frames
        if o_end > len(env_out):  # aligned output not fully captured — skip
            continue
        e_in_body = float(np.sqrt((env_in[start:tail_start].astype(np.float64) ** 2).mean())) \
            if tail_start > start else 0.0
        e_in_tail = float(np.sqrt((env_in[tail_start:end].astype(np.float64) ** 2).mean()))
        e_out_body = float(np.sqrt((env_out[o_start:o_tail_start].astype(np.float64) ** 2).mean())) \
            if o_tail_start > o_start else 0.0
        e_out_tail = float(np.sqrt((env_out[o_tail_start:o_end].astype(np.float64) ** 2).mean()))
        if e_in_tail <= 0:
            continue
        r_tail = e_out_tail / e_in_tail
        r_body = (e_out_body / e_in_body) if e_in_body > 0 else r_tail
        results.append({
            "start_s": start * hop_ms / 1000.0,
            "end_s": end * hop_ms / 1000.0,
            "tail_ratio": r_tail,
            "body_ratio": r_body,
            "clipped": bool(r_body >= body_ratio and r_tail < tail_ratio),
        })
    return results


def find_silence_regions(env, hop_ms=ENV_HOP_MS, thresh_ratio=UTTER_THRESH_RATIO,
                         min_ms=SILENCE_MIN_MS):
    """Silent spans of an envelope → list of (start_s, end_s)."""
    if len(env) == 0:
        return []
    ref = float(np.percentile(env, 95))
    if ref <= 0:
        return [(0.0, len(env) * hop_ms / 1000.0)]
    silent = env < ref * thresh_ratio
    regions = []
    start = None
    min_len = int(round(min_ms / hop_ms))
    for i, s in enumerate(silent):
        if s and start is None:
            start = i
        elif not s and start is not None:
            if i - start >= min_len:
                regions.append((start * hop_ms / 1000.0, i * hop_ms / 1000.0))
            start = None
    if start is not None and len(env) - start >= min_len:
        regions.append((start * hop_ms / 1000.0, len(env) * hop_ms / 1000.0))
    return regions


def gated_spans_from_events(events, sr=SR):
    """VAD gate-closed spans on the INPUT timeline, from meta.jsonl vad_gate
    events. Returns [(start_s, end_s)]; a session ending closed runs to +inf."""
    spans = []
    closed_at = None
    for ev in events:
        if ev.get("event") != "vad_gate":
            continue
        t = ev["in_pos"] / sr
        if ev.get("state") == "closed" and closed_at is None:
            closed_at = t
        elif ev.get("state") == "open" and closed_at is not None:
            spans.append((closed_at, t))
            closed_at = None
    if closed_at is not None:
        spans.append((closed_at, float("inf")))
    return spans


def classify_silences(silences, env_in, offset_frames, hop_ms=ENV_HOP_MS,
                      thresh_ratio=UTTER_THRESH_RATIO, active_frac=0.30,
                      gated_spans=(), gated_overlap=0.5):
    """Attribute output-silence regions. Three verdicts:

      "benign"     the latency-aligned input was silent there too (gaps
                   between words/keystrokes reproducing as silence)
      "vad_gated"  input WAS active but ≥ gated_overlap of the span falls
                   inside a VAD gate-closed period — intentional suppression
                   (keyboard, claps): correct behavior, NOT converter garble
      "dropout"    input active, not gated — audio went in, nothing came out
                   (starvation if drop/underrun events sit nearby, garble
                   otherwise)

    Returns [(start_s, end_s, category, input_active_fraction), ...] on the
    output timeline. Without the vad_gated class, correct VAD behavior would
    read as converter garble and the instrument would lie.
    """
    ref = float(np.percentile(env_in, 95)) if len(env_in) else 0.0
    off_s = offset_frames * hop_ms / 1000.0
    out = []
    for s, e in silences:
        i0 = max(0, int(round(s * 1000.0 / hop_ms)) - offset_frames)
        i1 = max(i0, int(round(e * 1000.0 / hop_ms)) - offset_frames)
        seg = env_in[i0:min(i1, len(env_in))]
        frac = float((seg >= ref * thresh_ratio).mean()) if len(seg) and ref > 0 else 0.0
        if frac < active_frac:
            out.append((s, e, "benign", frac))
            continue
        # map the output span back to the input timeline and overlap with gates
        in_s, in_e = s - off_s, e - off_s
        overlap = sum(
            max(0.0, min(in_e, g_e) - max(in_s, g_s)) for g_s, g_e in gated_spans
        )
        span = max(1e-9, in_e - in_s)
        out.append((s, e, "vad_gated" if overlap / span >= gated_overlap else "dropout",
                    frac))
    return out


# ── session I/O ──────────────────────────────────────────────────────


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "expected mono int16"
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0, sr


def load_events(path):
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


# ── plots ────────────────────────────────────────────────────────────


def _decimate_minmax(x, sr, target_pts=6000):
    """Min/max decimation for plotting long waveforms without aliasing."""
    if len(x) <= target_pts:
        t = np.arange(len(x)) / sr
        return t, x, x
    hop = len(x) // (target_pts // 2)
    n = len(x) // hop
    frames = x[: n * hop].reshape(n, hop)
    t = (np.arange(n) * hop + hop / 2) / sr
    return t, frames.min(axis=1), frames.max(axis=1)


def plot_aligned_waveforms(path, x_in, x_out, sr, offset_ms):
    off = offset_ms / 1000.0
    fig, axes = plt.subplots(2, 1, figsize=(12, 5), sharex=True, sharey=True)
    for ax, x, shift, color, label in (
        (axes[0], x_in, 0.0, C_IN, "input (as received)"),
        (axes[1], x_out, -off, C_OUT, f"output (shifted −{offset_ms:.0f} ms)"),
    ):
        t, lo, hi = _decimate_minmax(x, sr)
        ax.fill_between(t + shift, lo, hi, color=color, linewidth=0.4, alpha=0.85)
        ax.set_ylabel("amplitude")
        ax.legend([plt.Line2D([], [], color=color, lw=2)], [label],
                  loc="upper right", frameon=False)
    axes[1].set_xlabel("input-timeline seconds")
    fig.suptitle(f"Aligned waveforms — latency offset {offset_ms:.0f} ms "
                 f"(envelope cross-correlation)", fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


def plot_spectrograms(path, x_in, x_out, sr, offset_ms):
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    nfft, hop = 1024, 256
    specs = []
    for x in (x_in, x_out):
        n = max(0, (len(x) - nfft) // hop)
        if n == 0:
            specs.append(np.zeros((nfft // 2 + 1, 1)))
            continue
        idx = np.arange(nfft)[None, :] + hop * np.arange(n)[:, None]
        seg = x[idx] * np.hanning(nfft)[None, :]
        mag = np.abs(np.fft.rfft(seg, axis=1)).T
        specs.append(20 * np.log10(mag + 1e-6))
    vmax = max(s.max() for s in specs)
    vmin = vmax - 80
    for ax, spec, shift, title in (
        (axes[0], specs[0], 0.0, "input"),
        (axes[1], specs[1], -offset_ms / 1000.0, f"output (shifted −{offset_ms:.0f} ms)"),
    ):
        extent = [shift, shift + spec.shape[1] * hop / sr, 0, sr / 2 / 1000.0]
        im = ax.imshow(spec, origin="lower", aspect="auto", extent=extent,
                       cmap="magma", vmin=vmin, vmax=vmax)
        ax.set_ylabel("kHz")
        ax.set_title(title, fontsize=9, loc="left")
        ax.grid(False)
    axes[1].set_xlabel("input-timeline seconds")
    fig.colorbar(im, ax=axes, label="dB", fraction=0.03, pad=0.01)
    fig.suptitle("Spectrogram pair (shared dB scale)", fontsize=11)
    fig.savefig(path, dpi=140)
    plt.close(fig)


def plot_rms_envelope(path, env_in, env_out, hop_ms, offset_frames,
                      utterances, tail_results):
    t_in = np.arange(len(env_in)) * hop_ms / 1000.0
    t_out = (np.arange(len(env_out)) - offset_frames) * hop_ms / 1000.0
    fig, ax = plt.subplots(figsize=(12, 4))
    for s, e in utterances:
        ax.axvspan(s * hop_ms / 1000.0, e * hop_ms / 1000.0,
                   color="#eceae5", zorder=0)
    ax.plot(t_in, env_in, color=C_IN, lw=1.4, label="input RMS")
    ax.plot(t_out, env_out, color=C_OUT, lw=1.4, label="output RMS (aligned)")
    for r in tail_results:
        if r["clipped"]:
            ax.axvspan(max(r["start_s"], r["end_s"] - TAIL_MS / 1000.0), r["end_s"],
                       color=C_CRIT, alpha=0.25, zorder=1)
            ax.annotate("tail clipped", xy=(r["end_s"], float(np.max(env_in)) * 0.9),
                        color=C_CRIT, fontsize=8, ha="right")
    ax.set_xlabel("input-timeline seconds")
    ax.set_ylabel("RMS")
    ax.legend(loc="upper right", frameon=False)
    n_clip = sum(r["clipped"] for r in tail_results)
    ax.set_title(f"RMS envelopes — {len(utterances)} utterance(s), "
                 f"{n_clip} clipped tail(s)", fontsize=11, loc="left")
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


def plot_dropout_map(path, env_out, hop_ms, silences, events, out_dur_s):
    fig, ax = plt.subplots(figsize=(12, 4))
    t_out = np.arange(len(env_out)) * hop_ms / 1000.0
    ax.plot(t_out, env_out, color=C_MUTE, lw=1.0, label="output RMS")
    span_styles = {
        "benign": dict(color="#d8d7d2", alpha=0.6, label="silence (input silent too)"),
        "vad_gated": dict(color="#4a3aa7", alpha=0.25, label="VAD-gated (intentional)"),
        "dropout": dict(color=C_CRIT, alpha=0.30, label="DROPOUT (input was active)"),
    }
    seen = set()
    for s, e, category, _frac in silences:
        style = span_styles[category]
        ax.axvspan(s, e, color=style["color"], alpha=style["alpha"], zorder=0,
                   label=None if category in seen else style["label"])
        seen.add(category)
    marks = {
        "drop": dict(marker="x", color=C_CRIT, label="window drop (backpressure)"),
        "underrun": dict(marker="v", color=C_WARN, label="stitcher underrun"),
        "stale": dict(marker=".", color=C_MUTE, label="stale window discarded"),
        "window_lost": dict(marker="1", color=C_CRIT, label="window never returned"),
    }
    ymax = float(np.max(env_out)) if len(env_out) else 1.0
    seen = set()
    for ev in events:
        kind = ev.get("event")
        if kind not in marks:
            if kind == "mode_change":
                t = ev["out_pos"] / SR
                ax.axvline(t, color=C_IN, lw=1.0, ls="--")
                ax.annotate(ev.get("mode", "?"), xy=(t, ymax), color=C_IN,
                            fontsize=8, ha="left", rotation=90, va="top")
            continue
        m = marks[kind]
        ax.scatter(ev["out_pos"] / SR, ymax * 1.05, s=30, zorder=3,
                   marker=m["marker"], color=m["color"],
                   label=m["label"] if kind not in seen else None)
        seen.add(kind)
    ax.set_xlim(0, max(out_dur_s, 1.0))
    ax.set_xlabel("output-timeline seconds")
    ax.set_ylabel("RMS")
    ax.legend(loc="upper right", frameon=False, fontsize=8)
    n_drop = sum(1 for _s, _e, c, _f in silences if c == "dropout")
    n_gated = sum(1 for _s, _e, c, _f in silences if c == "vad_gated")
    ax.set_title(f"Dropout map — {len(silences)} silence region(s), {n_drop} dropout(s), "
                 f"{n_gated} VAD-gated; events pinned by output sample position",
                 fontsize=11, loc="left")
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


# ── report ───────────────────────────────────────────────────────────


def percentile(vals, q):
    return float(np.percentile(np.asarray(vals, dtype=np.float64), q)) if vals else None


def build_report(session_dir, header, x_in, x_out, offset_ms, peak_corr,
                 utterances, tail_results, silences, events, hop_ms):
    ev_count = {}
    for ev in events:
        ev_count[ev["event"]] = ev_count.get(ev["event"], 0) + 1
    turnarounds = [ev["turnaround_ms"] for ev in events
                   if ev["event"] == "window" and ev.get("turnaround_ms") is not None]
    depths = [ev["depth"] for ev in events if ev["event"] == "buffer_depth"]

    lines = []
    add = lines.append
    add(f"Capture analysis — {session_dir}")
    add("=" * 72)
    add(f"session header : {json.dumps({k: v for k, v in header.items() if k != 'event'})}")
    add(f"input          : {len(x_in) / SR:.2f} s ({len(x_in)} samples)")
    add(f"output         : {len(x_out) / SR:.2f} s ({len(x_out)} samples)")
    add(f"latency offset : {offset_ms:.0f} ms (envelope xcorr, peak corr {peak_corr:.3f})")
    add("")
    add(f"utterances     : {len(utterances)}")
    for r in tail_results:
        flag = "CLIPPED TAIL" if r["clipped"] else "ok"
        add(f"  {r['start_s']:7.2f}–{r['end_s']:.2f}s  body {r['body_ratio']:.2f}  "
            f"tail {r['tail_ratio']:.2f}  {flag}")
    n_clip = sum(r["clipped"] for r in tail_results)
    add(f"clipped tails  : {n_clip}")
    add("")
    counts = {"benign": 0, "vad_gated": 0, "dropout": 0}
    for _s, _e, c, _f in silences:
        counts[c] += 1
    add(f"output silences: {len(silences)} ({counts['benign']} benign — input silent "
        f"there too; {counts['vad_gated']} VAD-gated — intentional)")
    for s, e, category, frac in silences:
        if category == "benign":
            continue
        if category == "vad_gated":
            add(f"  VAD-GATED {s:7.2f}–{e:.2f}s  input active {frac:.0%}  (intentional)")
            continue
        near = [ev["event"] for ev in events
                if ev["event"] in ("drop", "underrun", "stale", "window_lost")
                and s - 0.5 <= ev["out_pos"] / SR <= e + 0.5]
        cause = (f"events nearby: {sorted(set(near))} → starvation"
                 if near else "NO events → converter garbled/suppressed it")
        add(f"  DROPOUT {s:7.2f}–{e:.2f}s  input active {frac:.0%}  ({cause})")
    add("")
    add(f"meta events    : {dict(sorted(ev_count.items()))}")
    if turnarounds:
        add(f"turnaround ms  : p50 {percentile(turnarounds, 50):.0f}  "
            f"p95 {percentile(turnarounds, 95):.0f}  n={len(turnarounds)}")
    if depths:
        add(f"buffer depth   : median {percentile(depths, 50):.0f} samples "
            f"({percentile(depths, 50) / header.get('hop', 6144):.2f} hops), "
            f"min {min(depths)}, max {max(depths)}")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Analyze a convert-agent capture session")
    ap.add_argument("session_dir", type=Path,
                    help="timestamped directory written by --capture-dir")
    args = ap.parse_args(argv)
    d = args.session_dir
    for name in ("input_48k.wav", "output_48k.wav", "meta.jsonl"):
        if not (d / name).exists():
            sys.exit(f"error: {d / name} not found — not a capture session dir")

    x_in, sr_in = read_wav(d / "input_48k.wav")
    x_out, sr_out = read_wav(d / "output_48k.wav")
    events = load_events(d / "meta.jsonl")
    header = next((e for e in events if e["event"] == "session"), {})

    env_in, _ = rms_envelope(x_in)
    env_out, _ = rms_envelope(x_out)
    offset_ms, peak_corr = estimate_offset_ms(env_in, env_out)
    offset_frames = int(round(offset_ms / ENV_HOP_MS))
    utterances = detect_utterances(env_in)
    tails = detect_tail_clips(env_in, env_out, offset_frames, utterances)
    silences = classify_silences(find_silence_regions(env_out), env_in, offset_frames,
                                 gated_spans=gated_spans_from_events(events))

    plot_aligned_waveforms(d / "aligned_waveforms.png", x_in, x_out, sr_in, offset_ms)
    plot_spectrograms(d / "spectrograms.png", x_in, x_out, sr_in, offset_ms)
    plot_rms_envelope(d / "rms_envelope.png", env_in, env_out, ENV_HOP_MS,
                      offset_frames, utterances, tails)
    plot_dropout_map(d / "dropout_map.png", env_out, ENV_HOP_MS, silences,
                     events, len(x_out) / sr_out)

    report = build_report(d, header, x_in, x_out, offset_ms, peak_corr,
                          utterances, tails, silences, events, ENV_HOP_MS)
    (d / "report.txt").write_text(report)
    print(report)
    print(f"plots written to {d}/")


if __name__ == "__main__":
    main()
