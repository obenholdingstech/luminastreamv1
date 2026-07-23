# LuminaStream Agents

Server-side pieces of the voice engine, built on the plain `livekit` rtc SDK
(v1.1.13), **not** the `livekit-agents` framework: the framework (v1.6.x) is
designed around STT/LLM/TTS voice-AI pipelines and worker dispatch —
unnecessary for raw frame processing. We revisit it when the conversion worker
needs orchestration.

Two agents:

- **`echo_agent.py`** (Stage 1, kept as the known-good transport reference) —
  joins `luminastream-test` as `echo-agent` and republishes the human
  participant's frames **unchanged**.
- **`convert_agent.py`** (Move 2b) — same transport skeleton plus a **live
  passthrough/convert toggle**. In convert mode, frames flow through the
  proven stateless sliding-window RVC pipeline (`bridge.py` + `rvc_client.py`,
  transplanted from `bridge_test_v3.py`): 14336-sample windows (8192 context +
  6144 hop) over a WebSocket to the RVC server, SOLA-aligned equal-power
  crossfade on the way back. Modes are switched at runtime from the
  `/livekit-test` page via LiveKit data messages
  (`{"type":"set_mode","mode":"convert"}`), and the agent confirms with
  `{"type":"agent_mode","mode":...}` — the agent is the source of truth.

## Prerequisites

- Python 3.9+ (macOS system Python works)
- `secrets.env` at the **repo root** with `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET` (the agent mints its own token server-side — it never
  uses a pasted/hardcoded token)

## Setup (once)

```bash
cd agent
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

## Run the echo agent (Stage 1 reference)

```bash
cd agent
./.venv/bin/python echo_agent.py
```

Expected output:

```
12:34:56 INFO    echo-agent — connected to room luminastream-test as echo-agent
12:34:56 INFO    echo-agent — published echo track (sid=TR_...) — waiting for a human participant
12:35:10 INFO    echo-agent — participant connected: test-user
12:35:10 INFO    echo-agent — echo started: test-user → echo-agent/48000Hz mono passthrough
12:35:15 INFO    echo-agent — stats: received=250 (+250) published=250 (+250) dropped=0 (+0)
```

Stop with Ctrl-C.

## Convert agent — Mac runbook (mock RVC, no GPU)

Full plumbing test on a laptop: the mock server speaks the exact RVC WebSocket
protocol and echoes windows back after ~70 ms (occasional 150 ms spike),
resampled ×1.008 to exercise SOLA the way the real server does.

```bash
cd agent

# 1. Unit tests
./.venv/bin/python -m pytest test_bridge.py -q

# 2. Mock RVC server (terminal 1)
./.venv/bin/python mock_rvc_server.py            # ws://127.0.0.1:8000/ws/audio

# 3. Convert agent (terminal 2) — warms up RVC BEFORE joining the room
./.venv/bin/python convert_agent.py              # starts in passthrough
```

Then open `/livekit-test`, connect as `test-user`, and use the
**Passthrough | Convert** buttons. Expectations:

- **passthrough** — you hear yourself at ~echo-agent latency; RVC idle.
- **convert** — you hear yourself ~200 ms later (window hop 128 ms + mock
  70 ms + jitter buffer), no stutter; the "Agent mode" indicator flips only
  when the agent confirms.
- Kill the mock server while converting → agent auto-falls back to
  passthrough (`reason: rvc_unavailable`), retries every 5 s, and restores
  convert mode by itself when the mock comes back.

Agent stats every 5 s: mode, frames in/out, windows sent/recv/dropped,
underruns, turnaround p50/p95, buffer depth.

## Capture diagnostics (Phase 1)

Add `--capture-dir captures/` to record each processing session for offline
analysis: `input_48k.wav` (frames as received), `output_48k.wav` (frames as
published), and `meta.jsonl` (per-window turnaround, drops, underruns, stale
discards, mode changes, jitter-buffer depth per hop). The frame loop only
ever appends to memory — a background task does all disk I/O — and without
the flag capture is fully disabled.

Analyze a session (plots + report written into the session dir):

```bash
./.venv/bin/python analyze_capture.py captures/<timestamp>/
```

The test protocol (fox sentence + keyboard typing, both modes) is documented
in the `analyze_capture.py` docstring.

### Phase 2 experiment — browser mic processing vs word clipping

Hypothesis under test: the browser's mic processing (noise suppression /
echo cancellation / auto gain) eats word tails before the pipeline ever sees
them. The `/livekit-test` page has **Mic Processing** toggles (default all
ON = browser default); toggling while connected re-acquires the mic in place
— no reconnect needed. The active state is shown next to the agent-mode
indicator (NS✓ EC✓ AGC✓).

Protocol — two capture sessions, **convert mode**, agent running with
`--capture-dir`:

1. Session A: all three toggles **ON**. Speak the fox sentence, then
   **"mic test one two" × 3** (short utterances with hard stops — the
   tail-clip probe).
2. Disconnect (closes the session), reconnect. Session B: all three toggles
   **OFF**. Same script.
3. Analyze both sessions and compare the utterance/tail table and clipped
   counts in `report.txt`:

```bash
./.venv/bin/python analyze_capture.py captures/<session-A>/
./.venv/bin/python analyze_capture.py captures/<session-B>/
```

If ON shows clipped tails that OFF doesn't, the browser processing is the
word-clipper and the fix belongs client-side (constraints), not in the
agent pipeline.

`lk_smoke.py` is the connectivity gate for any new environment: it must print
`CONNECTED OK` before anything else is worth debugging (see `runbook.md`).

## Convert agent — RunPod runbook (real RVC)

> **SUPERSEDED (22 Jul):** the agent must NOT run on RunPod — the RunPod
> runtime futex-crashes the LiveKit Rust FFI. Agent runs on a VPS, RVC on the
> pod, connected TCP-direct. See `runbook.md` at the repo root for the
> current deploy recipe; the section below is kept for the RVC-side details.

The agent runs **on the same pod as the RVC server**; the hop is loopback.

```bash
# 1. RVC server MUST be stateless — the bridge re-sends its own left context
#    (8192 samples) in every window; server-side context would pollute it.
export RVC_STREAM_CONTEXT_SECONDS=0
# ... launch the RVC server as usual (port 8000), then activate the model,
# e.g. aloy_beta12333333.pth from Move 1.

# 2. Agent (same box; needs secrets.env at the repo root)
export RVC_WS_URL=ws://127.0.0.1:8000/ws/audio    # this is also the default
python convert_agent.py --mode convert
```

`--mode convert` warms the model with a zero-window **before** the agent joins
the room, so the stream never sees a cold model. If RVC is down at startup or
drops mid-stream, the agent keeps the room alive in passthrough and recovers
on its own.

CLI/env: `RVC_WS_URL` (or `--rvc-url`), `--mode passthrough|convert`
(default passthrough), `--room`, `--identity`.

## Testing against the browser

Open `/livekit-test` in the app, generate a token
(`node scripts/generate-livekit-token.js` from the repo root), and connect as
`test-user` while the agent is running. The agent's log shows frames flowing.

The page plays the agent's returned track automatically (enable audio if the
browser blocks autoplay) — with either agent running you hear yourself echoed
back through the server.

## Troubleshooting

- `secrets.env must define …` — the file lives at the repo root (one level up
  from `agent/`), not inside `agent/`.
- Agent connects but never echoes — make sure the browser side joined with a
  different identity (the agents deliberately ignore identities starting with
  `echo-`, and only adopt one human track at a time).
- Convert mode sounds doubled/echoey on the pod — the RVC server was started
  **without** `RVC_STREAM_CONTEXT_SECONDS=0`. The bridge is stateless by
  design; server-side context pollutes the windows (proven in Move 2a).
- Convert button snaps back to passthrough with `rvc_unavailable` — the RVC
  server (or mock) isn't reachable at `RVC_WS_URL`; the agent retries every
  5 s and switches back automatically once it reconnects.
