# GPU interpolation drill (CEO mandate, 4 Aug 2026)

**The question:** what does a rented-GPU server hop cost in latency, and what
does true motion-compensated interpolation buy in smoothness, pushing the
lens's real ~19fps toward 50+?

**The shape:** one RunPod GPU pod (RTX 4090 class), booted from
`pod-bootstrap.sh` on this branch, running `server.py` — RIFE v4.26 fetched
from the author's own HuggingFace repo (`hzwer/RIFE`), ffmpeg `minterpolate`
as the classical fallback, and the server reports which tier loaded so every
number is labeled. The source clip is the REAL transformed stream captured
from production (`capture-source.mjs`).

**The measurements** (each isolated, so the tax decomposes):

| component | how |
|---|---|
| lookahead | structural: 1 frame interval at the real rate (1000/19 ≈ 53ms) |
| transport | 60 WS RTTs + 40 × 120KB frame-sized round trips, p50/p95 |
| synthesis | 50 timed `model.inference()` calls at 720p on the GPU |
| smoothness | the clip ×3 → ~57fps; `side-by-side.mp4` for the eye |

**Run:**

```sh
E2E_ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' secrets.env | head -1 | cut -d= -f2-)" \
  node scripts/gpu-drill/capture-source.mjs
bash scripts/gpu-drill/run-drill.sh   # provision → drill → teardown (trapped)
```

**Money rules:** the pod is created by `provision.sh` and terminated by
`teardown.sh`, which VERIFIES termination; `run-drill.sh` traps teardown on
every exit path — a leaked pod is a spend leak. The API key lives in
`secrets.env`, is never printed, and never leaves this machine; the pod
itself holds only a random per-drill token.

**Standing verdicts this drill informs, not overturns:** the production
architecture is GPU-server-free by doctrine (ROADMAP §P3). This drill exists
to price that doctrine's alternative with measurements instead of predictions.
