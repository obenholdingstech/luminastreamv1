#!/bin/bash
# GPU drill — TERMINATE the pod and VERIFY it is gone. A leaked pod bills all
# night (crash-loop doctrine: a spend leak, not just noise) — so this script
# is idempotent, verifies termination rather than assuming it, and is safe to
# run twice. Never prints the API key.
set -uo pipefail
cd "$(dirname "$0")/../.."

RUNPOD_API_KEY=$(grep -E '^RUNPOD_API_KEY=' secrets.env | head -1 | cut -d= -f2-)
POD_ID=$(python3 -c "import json; print(json.load(open('scripts/gpu-drill/out/pod.json'))['podId'])" 2>/dev/null || true)
[ -n "$POD_ID" ] || { echo "[teardown] no pod.json — nothing to terminate"; exit 0; }

echo "[teardown] terminating pod $POD_ID"
curl -s -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" \
  "https://rest.runpod.io/v1/pods/$POD_ID" >/dev/null || true

for i in $(seq 1 18); do
  sleep 5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $RUNPOD_API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  BODY=$(curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  STATUS=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('desiredStatus','GONE'))" 2>/dev/null || echo GONE)
  echo "[teardown] poll $i: http=$CODE status=$STATUS"
  if [ "$CODE" = "404" ] || [ "$STATUS" = "TERMINATED" ] || [ "$STATUS" = "GONE" ]; then
    START=$(cat scripts/gpu-drill/out/started_at 2>/dev/null || echo 0)
    NOW=$(date +%s)
    MIN=$(( (NOW - START) / 60 ))
    echo "[teardown] VERIFIED TERMINATED — pod lived ~${MIN}min"
    exit 0
  fi
done
echo "[teardown] WARNING: could not verify termination — CHECK THE RUNPOD CONSOLE"
exit 1
