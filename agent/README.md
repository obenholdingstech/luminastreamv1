# LuminaStream Echo Agent

First server-side piece of the voice engine (Stage 1). Joins the
`luminastream-test` LiveKit room as **`echo-agent`**, subscribes to the human
participant's audio, and republishes the frames **unchanged** as its own track.
The passthrough loop is exactly where the real voice-conversion model will slot
in later — same subscribe → process → publish shape, on a GPU worker.

Built on the plain `livekit` rtc SDK (v1.1.13), **not** the `livekit-agents`
framework: the framework (v1.6.x) is designed around STT/LLM/TTS voice-AI
pipelines and worker dispatch — unnecessary for raw frame passthrough. We
revisit it when the real conversion worker needs orchestration.

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

## Run

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

## Testing against the browser

Open `/livekit-test` in the app, generate a token
(`node scripts/generate-livekit-token.js` from the repo root), and connect as
`test-user` while the agent is running. The agent's log shows frames flowing.

**Note:** the `/livekit-test` page currently only *publishes* your mic — it does
not yet attach remote audio to a speaker element, so you won't *hear* the echo
in the browser yet. Wiring up remote-audio playback in the test page is the
natural next step; the agent's stats plus the browser's subscribed-track stats
already prove the full loop end to end.

## Troubleshooting

- `secrets.env must define …` — the file lives at the repo root (one level up
  from `agent/`), not inside `agent/`.
- Agent connects but never echoes — make sure the browser side joined with a
  different identity (the agent deliberately ignores identities starting with
  `echo-`, and only adopts one human track at a time).
