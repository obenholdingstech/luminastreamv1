# GPU interpolation drill server — runs on the rented pod (see pod-bootstrap.sh).
#
# A deliberately dumb worker with four jobs, each answering one drill question:
#   /ws           echo — network RTT and 720p-frame round-trip (the TRANSPORT tax)
#   /bench        pure model.inference() timing on GPU (the SYNTHESIS cost)
#   /interpolate  the real captured clip -> ~57fps via RIFE (the SMOOTHNESS artifact)
#   /artifact     download what was produced
#
# Every route requires X-Drill-Token (env DRILL_TOKEN) — the pod sits on a
# public IP; without the token this would be anyone's free GPU. The token is
# minted per drill by the orchestrator and never committed anywhere.

import asyncio
import glob
import json
import os
import subprocess
import time

from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

TOKEN = os.environ.get("DRILL_TOKEN", "")
WORK = "/workspace/drill"
OUT = os.path.join(WORK, "out")
os.makedirs(OUT, exist_ok=True)

app = FastAPI()
log = []


def note(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    log.append(line)
    print(line, flush=True)


def auth(x_drill_token):
    if not TOKEN or x_drill_token != TOKEN:
        raise HTTPException(status_code=403, detail="bad drill token")


def sh(cmd, timeout=1800, cwd=WORK):
    note(f"$ {' '.join(cmd[:6])}…")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)


def model_tier():
    try:
        return open(os.path.join(WORK, "model_tier")).read().strip()
    except OSError:
        return "unknown"


def gpu_name():
    try:
        import torch

        return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO CUDA"
    except Exception as e:  # noqa: BLE001 — health must report, not crash
        return f"torch unavailable: {e}"


@app.get("/health")
def health(x_drill_token: str = Header(default="")):
    auth(x_drill_token)
    return {"ok": True, "tier": model_tier(), "gpu": gpu_name()}


@app.get("/log")
def get_log(x_drill_token: str = Header(default="")):
    auth(x_drill_token)
    return {"log": log[-100:]}


@app.websocket("/ws")
async def ws_echo(ws: WebSocket):
    # RTT + frame round-trip measure. Token rides the query string because
    # browsers cannot set WS headers and the client mirrors that limitation.
    if ws.query_params.get("token") != TOKEN or not TOKEN:
        await ws.close(code=4403)
        return
    await ws.accept()
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await ws.send_bytes(msg["bytes"])
            elif msg.get("text") is not None:
                await ws.send_text(msg["text"])
    except Exception:  # noqa: BLE001 — client gone is a normal end
        pass


@app.post("/clip")
async def upload_clip(file: UploadFile = File(...), x_drill_token: str = Header(default="")):
    auth(x_drill_token)
    raw = os.path.join(WORK, "source_upload")
    with open(raw, "wb") as f:
        f.write(await file.read())
    # Normalize to h264 mp4 WITHOUT resampling time: keep every frame and its
    # native rate so the interpolation multiplies the real 19fps, not a lie.
    r = sh(["ffmpeg", "-y", "-i", raw, "-c:v", "libx264", "-crf", "18", "-an",
            os.path.join(OUT, "source.mp4")])
    if r.returncode != 0:
        note(f"clip normalize FAILED: {r.stderr[-400:]}")
        raise HTTPException(status_code=422, detail=r.stderr[-400:])
    probe = sh(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams",
                os.path.join(OUT, "source.mp4")])
    info = json.loads(probe.stdout)["streams"][0]
    note(f"clip: {info['width']}x{info['height']} {info.get('avg_frame_rate')} {info.get('nb_frames')} frames")
    return {"ok": True, "stream": {k: info.get(k) for k in ("width", "height", "avg_frame_rate", "nb_frames")}}


@app.post("/bench")
def bench(x_drill_token: str = Header(default="")):
    """Pure synthesis cost: model.inference() on 1280x720 pairs, fp32, batch 1."""
    auth(x_drill_token)
    if not model_tier().startswith("rife"):
        return JSONResponse({"ok": False, "reason": f"tier is {model_tier()} — no model to bench"})
    try:
        import sys

        import torch

        sys.path.insert(0, os.path.join(WORK, "rife"))
        from train_log.RIFE_HDv3 import Model  # noqa: PLC0415 — pod-runtime import

        model = Model()
        model.load_model(os.path.join(WORK, "rife", "train_log"), -1)
        model.eval()
        model.device()
        # 720p padded to /32 as RIFE requires
        w, h = 1280, 736
        i0 = torch.rand(1, 3, h, w, device="cuda")
        i1 = torch.rand(1, 3, h, w, device="cuda")
        for _ in range(5):
            model.inference(i0, i1)
        torch.cuda.synchronize()
        times = []
        for _ in range(50):
            t0 = time.perf_counter()
            model.inference(i0, i1)
            torch.cuda.synchronize()
            times.append((time.perf_counter() - t0) * 1000)
        times.sort()
        result = {"ok": True, "p50_ms": round(times[25], 2), "p95_ms": round(times[47], 2),
                  "gpu": gpu_name()}
        note(f"bench: {result}")
        return result
    except Exception as e:  # noqa: BLE001 — report, never crash the drill
        note(f"bench FAILED: {e}")
        return JSONResponse({"ok": False, "reason": str(e)})


@app.post("/interpolate")
def interpolate(multi: int = 3, x_drill_token: str = Header(default="")):
    """The artifact: source.mp4 -> multi× frame rate, plus a side-by-side."""
    auth(x_drill_token)
    src = os.path.join(OUT, "source.mp4")
    if not os.path.exists(src):
        raise HTTPException(status_code=409, detail="upload /clip first")
    tier = model_tier()
    t0 = time.perf_counter()

    if tier.startswith("rife"):
        for old in glob.glob(os.path.join(OUT, "source_*X*.mp4")):
            os.remove(old)
        # cwd is the RIFE checkout: inference_video.py resolves train_log/
        # relative to its working directory. The OUTPUT still lands next to
        # the source (absolute path), which is where the glob looks.
        r = sh(["python3", "inference_video.py", f"--multi={multi}", f"--video={src}"],
               timeout=3600, cwd=os.path.join(WORK, "rife"))
        # inference_video writes next to the source with an NX suffix; find it
        produced = glob.glob(os.path.join(OUT, "source_*X*.mp4"))
        if r.returncode != 0 or not produced:
            note(f"RIFE interpolate FAILED: {r.stderr[-600:]}")
            raise HTTPException(status_code=500, detail=r.stderr[-600:])
        os.replace(produced[0], os.path.join(OUT, "interpolated.mp4"))
        method = tier
    else:
        r = sh(["ffmpeg", "-y", "-i", src,
                "-vf", "minterpolate=fps=57:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
                "-c:v", "libx264", "-crf", "18", "-an", os.path.join(OUT, "interpolated.mp4")],
               timeout=3600)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=r.stderr[-600:])
        method = "ffmpeg-minterpolate"
    wall_s = time.perf_counter() - t0

    probe = sh(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams",
                os.path.join(OUT, "interpolated.mp4")])
    info = json.loads(probe.stdout)["streams"][0]
    out_frames = int(info.get("nb_frames") or 0)

    # Side-by-side for the CEO's eye: original duplicated up to the same clock
    # (KEEPS its judder — that is the comparison) beside the synthesized one.
    fps = info.get("avg_frame_rate", "57/1")
    sh(["ffmpeg", "-y", "-i", src, "-i", os.path.join(OUT, "interpolated.mp4"),
        "-filter_complex",
        f"[0:v]fps={fps},scale=640:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='ORIGINAL 19fps':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5:x=20:y=20[l];"
        f"[1:v]scale=640:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='INTERPOLATED {method}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5:x=20:y=20[r];"
        "[l][r]hstack", "-c:v", "libx264", "-crf", "18", "-an",
        os.path.join(OUT, "side-by-side.mp4")])

    result = {"ok": True, "method": method, "wall_s": round(wall_s, 1),
              "out_frames": out_frames, "out_fps": fps,
              "ms_per_output_frame_incl_io": round(wall_s * 1000 / max(out_frames, 1), 2)}
    note(f"interpolate: {result}")
    with open(os.path.join(OUT, "timings.json"), "w") as f:
        json.dump(result, f)
    return result


@app.get("/artifact/{name}")
def artifact(name: str, x_drill_token: str = Header(default="")):
    auth(x_drill_token)
    path = os.path.join(OUT, os.path.basename(name))
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="no such artifact")
    return FileResponse(path)


if __name__ == "__main__":
    note(f"drill server up — tier={model_tier()} gpu={gpu_name()}")
    uvicorn.run(app, host="0.0.0.0", port=8000)
