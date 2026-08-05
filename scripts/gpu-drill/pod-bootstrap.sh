#!/bin/bash
# GPU interpolation drill — pod bootstrap (CEO mandate, 4 Aug 2026).
#
# Runs INSIDE the rented RunPod container at boot (dockerStartCmd curls this
# from the public repo's drill branch). Installs the stack, fetches the RIFE
# model from the AUTHOR'S OWN HuggingFace repo (hzwer/RIFE — a verified,
# cited URL, not an invented mirror), and starts the drill server. If the
# model fetch fails the server still starts: ffmpeg's minterpolate is the
# classical motion-compensated floor, and the server reports WHICH tier
# loaded so every number the drill produces is labeled honestly.
#
# The pod holds no secrets. Control auth is DRILL_TOKEN, a random per-drill
# value passed as an env var at pod creation and required on every route —
# the server listens on a public IP and would otherwise be anyone's GPU.
set -uo pipefail

REPO_RAW="https://raw.githubusercontent.com/obenholdingstech/luminastreamv1/drill/gpu-interpolation/scripts/gpu-drill"
MODEL_URL="https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip"
WORK=/workspace/drill
mkdir -p "$WORK" && cd "$WORK"

echo "[bootstrap] apt + pip deps"
apt-get update -qq && apt-get install -y -qq ffmpeg git fonts-dejavu-core >/dev/null
pip install -q fastapi 'uvicorn[standard]' pillow numpy python-multipart

echo "[bootstrap] cloning Practical-RIFE (inference code)"
git clone -q --depth 1 https://github.com/hzwer/Practical-RIFE.git rife || true
pip install -q -r rife/requirements.txt || true

echo "[bootstrap] fetching RIFE v4.26 package from hzwer/RIFE (HF)"
MODEL_TIER="ffmpeg-minterpolate"
if curl -sL -o model.zip "$MODEL_URL" && python3 - <<'PY'
import sys, zipfile, os, shutil
z = zipfile.ZipFile('model.zip')
z.extractall('model_tmp')
os.makedirs('rife/train_log', exist_ok=True)
found = False
for root, _, files in os.walk('model_tmp'):
    for f in files:
        if f.endswith('.py') or f == 'flownet.pkl':
            shutil.copy(os.path.join(root, f), os.path.join('rife/train_log', f))
            found = found or f == 'flownet.pkl'
sys.exit(0 if found else 1)
PY
then
  MODEL_TIER="rife-4.26-official-hf"
fi
echo "[bootstrap] model tier: $MODEL_TIER"
echo "$MODEL_TIER" > "$WORK/model_tier"

echo "[bootstrap] fetching drill server"
curl -sL -o server.py "$REPO_RAW/server.py"

echo "[bootstrap] starting server on :8000"
exec python3 server.py
