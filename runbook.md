# LuminaStream — Disaster Recovery Runbook

Full recipe to rebuild the production stack from zero. Written so that a cold
start (new pod, new VPS, nothing running) gets back to a working
browser → LiveKit → agent → RVC → browser loop without re-deriving anything.

Companion docs: `agent/README.md` (agent + mock runbooks), `RVC_SERVER_SETUP.md`
(original server guide), `devlog/SESSIONS.md` + `notes.md` (history and
rationale). Secrets live only in `secrets.env` (repo root, never committed) —
nothing in this file is a credential.

## Topology

```
Browser (/livekit-test) ⇄ LiveKit Cloud ⇄ convert_agent.py (VPS, EU)
                                             ⇅ WebSocket (TCP-direct)
                                          RVC server (RunPod GPU pod)
```

**The agent NEVER runs on RunPod.** The RunPod runtime futex-crashes the
LiveKit Rust FFI. Agent = VPS; RVC = pod. No exceptions.

## Golden rules (each learned the hard way)

1. **Pod image:** `ubuntu2204 / py3.10 / cu118` community template (the
   `rehabc` image) — **NEVER ubuntu2404** (RunPod runtime futex-crashes the
   LiveKit Rust FFI on it; and per rule above, don't run the agent on RunPod
   at all).
2. **All ports at deploy time, never edit-after.** Editing ports forces a pod
   restart and the host slot is lost to the scheduler (you may not get a GPU
   back). Declare at deploy: **HTTP 8888, TCP 22 + 8000**.
3. **TCP-direct is mandatory for agent↔RVC.** The Cloudflare proxy
   (`*.proxy.runpod.net`) blocks machine-to-machine WebSocket upgrades. Use
   the pod's TCP NAT mapping for port 8000. The **external NAT port CHANGES
   on every deploy** — refresh `RVC_WS_URL` on the VPS after each pod deploy.
4. **Stop, don't Terminate.** Stopping keeps the pod definition and its port
   mappings reusable; terminating throws them away. The network volume
   survives either way, but Stop is the discipline.
5. **Stateless server or garbage audio:** the RVC server must run with
   `RVC_STREAM_CONTEXT_SECONDS=0` (the agent's sliding-window protocol
   assumes stateless windows).
6. **Gate every environment with `agent/lk_smoke.py`** — if it doesn't print
   `CONNECTED OK`, fix credentials/network before touching anything else.

## Part 1 — RVC pod (RunPod)

### Deploy

1. RunPod → Deploy → Pods, region **EU-RO-1**, attach network volume
   **`koehrg7i63`** mounted at **`/workspace`** (holds the RVC checkout,
   models: `aloy_beta12333333.pth`, hubert 181 MB, rmvpe 173 MB).
2. Template: community **ubuntu2204 / py3.10 / cu118** (`rehabc` image).
   Never ubuntu2404 (rule 1).
3. Declare ALL ports now (rule 2): **HTTP 8888, TCP 22 and 8000**.
4. Deploy. Note the TCP NAT mapping for 8000 — that external `ip:port` is the
   new `RVC_WS_URL` target (rule 3).

### First commands on the pod

```bash
nvidia-smi                    # GPU actually there and driver sane (12.8 era)
apt install -y tmux           # not on the image
```

### RVC venv rebuild (needed whenever the image/libc changes)

The venv is **glibc-bound** — `pyworld` compiles against the image's libc, so
a venv built on another image will not import. Rebuild on the pod with `uv`
(note: **`.venv/bin/pip` does not exist in uv venvs** — always `uv pip`):

```bash
cd /workspace/<rvc-checkout>
uv venv --python 3.10
uv pip install -r backend/requirements.txt
# RVC pinned to the exact commit this stack was validated against — disaster
# recovery must be deterministic; upstream moves and can break the streaming path
uv pip install --no-deps "git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion@7b284a634667c34103eaaeed972b48ccdb4b893e"
uv pip install "setuptools<80"
uv pip uninstall onnxruntime && uv pip install onnxruntime-gpu
```

**torch pin:** the requirements resolve a cu13x torch, newer than the driver
(12.8) — swap it:

```bash
uv pip install --reinstall "torch==2.8.*" "torchaudio==2.8.*" \
  --index-url https://download.pytorch.org/whl/cu128
.venv/bin/python -c "import torch; print(torch.cuda.is_available())"   # must be True
```

### Launch (stateless, in tmux)

```bash
tmux new -s rvc
# stateless windows — rule 5; the flag has appeared under two spellings in
# server configs, so export both (grep the backend for RVC_STREAM_CONTEXT to
# confirm the exact names in the current checkout):
export RVC_STREAM_CONTEXT_SECONDS=0
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Ctrl-B D to detach
```

Activate the model via the API/UI and **verify the activation response says
`"device":"cuda:0"`** — anything else means CPU inference and the pod is
useless until fixed (recheck the torch pin above).

## Part 2 — Agent host (VPS)

Any **real KVM VM** (not a container VPS), **EU** region for latency.

### Setup from zero

```bash
apt update && apt install -y python3-venv git tmux ufw fail2ban
adduser lumina && usermod -aG sudo lumina    # run as non-root
su - lumina
git clone <this repo> && cd luminastreamv1
# secrets.env at repo root: HAND-TYPE it (LIVEKIT_URL, LIVEKIT_API_KEY,
# LIVEKIT_API_SECRET) — never paste through shared clipboards/chat
cd agent && python3 -m venv .venv && ./.venv/bin/python -m pip install -r requirements.txt
```

Firewall — SSH in only, everything else denied (agent↔LiveKit and agent↔RVC
are outbound, so nothing else needs to be open):

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status verbose        # verify: deny (incoming), allow (outgoing), 22/tcp ALLOW
sudo systemctl enable --now fail2ban
```

### GATE — before anything else

```bash
./.venv/bin/python lk_smoke.py     # must print CONNECTED OK
```

`lk_smoke.py` resolves `secrets.env` relative to its own path, so it works on
any checkout location unchanged. No `CONNECTED OK` → fix `secrets.env` /
egress before starting any agent.

### Agent launch

```bash
tmux new -s agent
export RVC_WS_URL=ws://<pod-nat-ip>:<current-external-port>/ws/audio   # rule 3: changes EVERY pod deploy
./.venv/bin/python convert_agent.py --mode convert
# diagnostics when needed: add --capture-dir captures/ (see analyze_capture.py)
```

Healthy stats line (every 5 s): `frames in == out`, `dropped=0`, buffer
~1.3–1.5 hops, turnaround p50 well under the 128 ms hop.

## Bring-up order (cold start checklist)

1. Pod deployed per Part 1 → `nvidia-smi` OK → venv imports → server up in
   tmux → model activated with `"device":"cuda:0"`.
2. Note the pod's current TCP NAT port for 8000 → new `RVC_WS_URL`.
3. VPS: `lk_smoke.py` → `CONNECTED OK` (the gate).
4. Agent in tmux with the fresh `RVC_WS_URL` → log shows
   `RVC ready (warmup …s)` then `connected to room`.
5. Browser `/livekit-test` → connect → toggle Convert → indicator shows the
   agent-confirmed mode.
6. Done working: **Stop the pod (never Terminate)** — rule 4.

## Local fallback (no GPU, Mac)

Everything except real conversion can be exercised locally:
`agent/mock_rvc_server.py` speaks the exact RVC protocol (see
`agent/README.md`). Used for plumbing work and the capture→analyze
diagnostic cycle (`--capture-dir` + `analyze_capture.py`).
