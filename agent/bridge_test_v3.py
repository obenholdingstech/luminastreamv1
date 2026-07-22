#!/usr/bin/env python3
"""Move 2a v3: STATELESS sliding-window conversion + SOLA-aligned crossfade. Server must be running with RVC_STREAM_CONTEXT_SECONDS=0."""
import asyncio, json, struct, sys, time
from fractions import Fraction
from pathlib import Path
import numpy as np

try:
    import soundfile as sf
except ImportError:
    sys.exit("run: .venv/bin/pip install soundfile")
try:
    import websockets
except ImportError:
    sys.exit("run: .venv/bin/pip install websockets")
from scipy.signal import resample_poly

WS_URL   = "ws://127.0.0.1:8000/ws/audio"
SR       = 48000
FRAME    = 480        # 10ms LiveKit delivery unit
HOP      = 6144       # new audio per window (128 ms) — the latency knob
CTX      = 8192       # left context re-converted each window (stateless)
XFADE    = 1024       # crossfade length
SOLA     = 384        # phase-alignment search radius
WINDOW   = CTX + HOP
REALTIME = True

CONFIG = {"sample_rate": SR, "chunk_size": WINDOW, "f0_method": "rmvpe", "index_rate": 0.75, "protect": 0.33, "rms_mix_rate": 0.25, "filter_radius": 3, "pitch_shift": 0}
INPUTS  = ["myvoice_input.wav", "speech_input.wav", "test_input.wav"]
OUT_WAV = "bridge_test_v3_output.wav"

def load_input():
    for name in INPUTS:
        p = Path(name)
        if p.exists():
            x, sr = sf.read(p, dtype="float32", always_2d=True)
            x = x.mean(axis=1)
            if sr != SR:
                fr = Fraction(SR, sr)
                x = resample_poly(x, fr.numerator, fr.denominator).astype("float32")
            print(f"input: {name} ({sr} -> {SR} Hz, {len(x)/SR:.1f}s)")
            return x.astype("float32")
    sys.exit(f"no input wav found among {INPUTS}")

async def run():
    x = load_input()
    sent_t, recv, recv_t = {}, {}, {}
    n_sent = 0; dropped = 0

    async with websockets.connect(WS_URL, max_size=None) as ws:
        await ws.send(json.dumps(CONFIG))
        warm = np.zeros(WINDOW, dtype="<f4")
        await ws.send(struct.pack("<II", 0, 0) + warm.tobytes())
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < 60:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=60)
            except asyncio.TimeoutError:
                break
            if isinstance(msg, (bytes, bytearray)):
                print(f"warmup done in {time.perf_counter()-t0:.1f}s"); break
            print("server text:", str(msg)[:160])

        async def receiver():
            async for msg in ws:
                now = time.perf_counter()
                if isinstance(msg, str):
                    print("server text:", msg[:160]); continue
                b = bytes(msg)
                if len(b) >= 8 and (len(b) - 8) % 4 == 0:
                    seq, _ = struct.unpack("<II", b[:8])
                    pcm = np.frombuffer(b[8:], dtype="<f4")
                else:
                    seq = len(recv) + 1
                    pcm = np.frombuffer(b, dtype="<f4")
                recv[seq] = pcm.astype("float32"); recv_t[seq] = now
        rtask = asyncio.create_task(receiver())

        start = time.perf_counter(); pos = 0; hop_i = 0
        while pos < len(x):
            if REALTIME:
                target = start + (hop_i + 1) * HOP / SR
                d = target - time.perf_counter()
                if d > 0: await asyncio.sleep(d)
                hop_i += 1
            end = min(pos + HOP, len(x))
            if n_sent - len(recv) >= 2:
                dropped += 1; print("DROP: backlog, skipping hop"); pos = end; continue
            
            lo = max(0, end - WINDOW)
            win = x[lo:end]
            if len(win) < WINDOW:
                win = np.concatenate([np.zeros(WINDOW - len(win), dtype="float32"), win])
            n_sent += 1
            await ws.send(struct.pack("<II", n_sent, 0) + win.astype("<f4").tobytes())
            sent_t[n_sent] = time.perf_counter(); pos = end
            
        deadline = time.perf_counter() + 15
        while len(recv) < n_sent and time.perf_counter() < deadline:
            await asyncio.sleep(0.1)
        rtask.cancel()

        # SOLA reassembly in sequence order
        got = sorted(recv)
        out = np.zeros(0, dtype="float32")
        t = np.linspace(0, np.pi/2, XFADE, dtype="float32")
        fin, fout = np.sin(t)**2, np.cos(t)**2
        for s in got:
            w = recv[s]
            need = HOP + XFADE + 2*SOLA
            seg = w[-need:] if len(w) >= need else w
            if len(out) < XFADE or len(seg) < XFADE + HOP:
                out = np.concatenate([out, seg[-HOP:] if len(seg) >= HOP else seg]); continue
            
            ref = out[-XFADE:]
            max_off = min(2*SOLA, len(seg) - XFADE - HOP)
            best_off, best_corr = 0, -1e18
            for off in range(0, max_off + 1, 8):
                cand = seg[off:off+XFADE]
                corr = float(np.dot(ref, cand)) / (float(np.linalg.norm(cand)) + 1e-9)
                if corr > best_corr:
                    best_corr, best_off = corr, off
            
            cand = seg[best_off:best_off+XFADE]
            out = out.copy()
            out[-XFADE:] = ref*fout + cand*fin
            out = np.concatenate([out, seg[best_off+XFADE : best_off+XFADE+HOP]])
            
        sf.write(OUT_WAV, out, SR)

        lat = sorted((recv_t[s]-sent_t[s])*1000 for s in got if s in sent_t)
        p50 = lat[len(lat)//2] if lat else float("nan")
        p95 = lat[int(len(lat)*0.95)] if lat else float("nan")
        hop_ms = HOP / SR * 1000
        in_rms = float(np.sqrt(np.mean(x**2)))
        out_rms = float(np.sqrt(np.mean(out[HOP:]**2))) if len(out) > HOP else 0.0

        print("\n===== MOVE 2a v3 RESULTS =====")
        print(f"windows sent/recv:  {n_sent} / {len(got)}   dropped hops: {dropped}")
        print(f"length ratio:       {len(out)/max(len(x),1):.3f}")
        print(f"rms in/out:         {in_rms:.4f} / {out_rms:.4f}")
        print(f"turnaround p50/p95: {p50:.0f} / {p95:.0f} ms  (hop {hop_ms:.0f} ms, window {WINDOW/SR*1000:.0f} ms)")
        print(f"real-time factor:   {p50/hop_ms:.2f} vs hop (< 1.0 keeps up)")
        print(f"est. added latency: {hop_ms:.0f} + {p50:.0f} = {hop_ms+p50:.0f} ms")
        print(f"budget math:        185 + {hop_ms+p50:.0f} = {185+hop_ms+p50:.0f} ms vs 500 target")
        print(f"output:             {OUT_WAV} -> EAR TEST: flow? converted?")

asyncio.run(run())