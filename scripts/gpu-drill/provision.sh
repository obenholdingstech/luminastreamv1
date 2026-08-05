#!/bin/bash
# GPU drill — provision the pod (Mac side). Creates one RunPod GPU pod that
# boots pod-bootstrap.sh from THIS branch on GitHub, then health-gates it.
#
#   bash scripts/gpu-drill/provision.sh
#
# Reads RUNPOD_API_KEY from secrets.env. NOTHING here ever prints the key.
# State (pod id, ip, port, per-drill token) goes to scripts/gpu-drill/out/
# which is gitignored. Teardown is teardown.sh — run-drill.sh traps it so a
# failed drill can not leak a running pod (a leaked pod is a spend leak).
set -euo pipefail
cd "$(dirname "$0")/../.."

RUNPOD_API_KEY=$(grep -E '^RUNPOD_API_KEY=' secrets.env | head -1 | cut -d= -f2-)
[ -n "$RUNPOD_API_KEY" ] || { echo "RUNPOD_API_KEY missing from secrets.env"; exit 1; }

OUT=scripts/gpu-drill/out
mkdir -p "$OUT"
DRILL_TOKEN=$(/usr/bin/openssl rand -hex 16)
RAW="https://raw.githubusercontent.com/obenholdingstech/luminastreamv1/drill/gpu-interpolation/scripts/gpu-drill"

echo "[provision] creating pod (RTX 4090 class, SECURE cloud)"
CREATE=$(curl -s -X POST https://rest.runpod.io/v1/pods \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d @- <<JSON
{
  "name": "lumina-gpu-drill",
  "imageName": "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04",
  "gpuTypeIds": ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090"],
  "gpuCount": 1,
  "cloudType": "SECURE",
  "ports": ["8000/tcp"],
  "containerDiskInGb": 40,
  "volumeInGb": 0,
  "env": { "DRILL_TOKEN": "$DRILL_TOKEN" },
  "dockerStartCmd": ["bash", "-c", "curl -sL $RAW/pod-bootstrap.sh | bash"]
}
JSON
)
POD_ID=$(printf '%s' "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
if [ -z "$POD_ID" ]; then
  echo "[provision] CREATE FAILED:"; printf '%s\n' "$CREATE"; exit 1
fi
COST=$(printf '%s' "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('costPerHr','?'))" 2>/dev/null || echo '?')
echo "[provision] pod $POD_ID created, costPerHr=$COST — waiting for network"
date +%s > "$OUT/started_at"

IP=""; PORT=""
for i in $(seq 1 60); do
  sleep 10
  POD=$(curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  read -r IP PORT < <(printf '%s' "$POD" | python3 -c "
import json, sys
p = json.load(sys.stdin)
ip = p.get('publicIp') or ''
pm = p.get('portMappings') or {}
print(ip, pm.get('8000', ''))" 2>/dev/null) || true
  echo "[provision] poll $i: ip=${IP:-—} port=${PORT:-—}"
  [ -n "$IP" ] && [ -n "$PORT" ] && break
done
[ -n "$IP" ] && [ -n "$PORT" ] || { echo "[provision] no public endpoint after 10min — run teardown.sh"; exit 1; }

python3 - "$POD_ID" "$IP" "$PORT" "$DRILL_TOKEN" "$COST" <<'PY'
import json, sys
open('scripts/gpu-drill/out/pod.json', 'w').write(json.dumps({
    'podId': sys.argv[1], 'ip': sys.argv[2], 'port': int(sys.argv[3]),
    'token': sys.argv[4], 'costPerHr': sys.argv[5]}))
PY

echo "[provision] health-gating http://$IP:$PORT (bootstrap installs take minutes)"
for i in $(seq 1 90); do
  sleep 10
  H=$(curl -s -m 5 -H "X-Drill-Token: $DRILL_TOKEN" "http://$IP:$PORT/health" || true)
  if printf '%s' "$H" | grep -q '"ok"'; then
    echo "[provision] HEALTH OK: $H"
    exit 0
  fi
  echo "[provision] health poll $i: not yet"
done
echo "[provision] server never came healthy — run teardown.sh"; exit 1
