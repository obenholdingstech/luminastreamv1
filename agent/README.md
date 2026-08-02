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

- **Python 3.10 or newer.** Not 3.9, and macOS's system Python (3.9.6) is
  therefore not enough — `brew install python@3.12` or equivalent.

  This is a security floor, not a style preference. `requirements.txt` pins
  `aiohttp>=3.14.1` on 3.10+ and falls back to `3.13.5` below it, because ten
  advisories against 3.13.5 are first patched in 3.14.x — which **requires**
  3.10. On a 3.9 interpreter the patched version cannot be installed at all, so
  the marker silently resolves to the vulnerable one. The VPS runs 3.12; a Mac
  harness on 3.9 is testing a dependency set production does not have.
- `secrets.env` at the **repo root** with `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET` (the agent mints its own token server-side — it never
  uses a pasted/hardcoded token)

## Setup (once)

```bash
cd agent
python3.12 -m venv .venv          # NOT `python3` on macOS — that is 3.9
./.venv/bin/python -m pip install -r requirements.txt
```

`python -m pip`, never `./.venv/bin/pip`. That shim is a `#!/bin/sh`
trampoline holding an **absolute** path to the interpreter it was created
with, so a repo that has been moved, copied or synced installs into a
different site-packages entirely — and reports success while doing it. This
project lost a session to exactly that (`ROADMAP.md` §4, doctrine 13).

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

Mic prerequisites on the Mac (confounds otherwise invalidate the A/B):

- macOS mic mode MUST be **"Standard"**, not Voice Isolation — Control
  Center → Mic Mode while the browser is capturing. Voice Isolation is
  OS-level DSP that clips tails upstream of everything these toggles control.
- Use the **built-in Mac microphone** — no AirPods/headsets, whose onboard
  DSP is a second uncontrolled processing stage.

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

## Phase 3 — Silero VAD gate

Non-speech audio (keyboard, doors, breaths) reaching RVC comes back as
hallucinated garble — Phase 2 pod captures attributed the bulk of dropouts to
the converter choking on partial-energy input. The agent now gates the
pipeline with Silero VAD (`vad.py`, silero-vad 6.2.1 pinned): each 128 ms hop
is resampled 48k→16k (analysis only — RVC still gets 48k) and scored; only
hops with speech probability ≥ threshold, plus a **hangover** tail after the
last speech, are sent to the RVC server. Everything else becomes clean
silence on the output, with 15 ms equal-power ramps at every gate edge.

Properties worth knowing:

- **Context is never sacrificed** — the sliding-window assembler keeps
  accumulating through gated periods, so the first window after gate-open
  carries real acoustic context (asserted in code and tests).
- **Tail protection** — hangover default 300 ms (`--vad-hangover-ms`),
  rounded UP to whole hops (384 ms effective). The VAD must not become the
  word-clipper Phase 2 exonerated the browser of.
- **Fail-open** — model load/runtime failure ⇒ one loud log + a data-channel
  report, then the agent runs ungated. The stream survives, like the
  RVC-failure fallback.
- **Idle GPU is the point** — gated hops enqueue nothing on the websocket
  and are counted as `gated` in the stats line, never as drops.
- Gate state rides in the `agent_mode` data-channel payload
  (`vad: {enabled, gate, threshold, hangover_ms}`) — additive; the current
  frontend ignores it (Phase 4's console consumes it).

Flags: `--no-vad` (default: VAD on), `--vad-threshold 0.5` (silero's own
default), `--vad-hangover-ms 300`. Active config is logged at startup.

### Phase 3 acceptance protocol

One convert-mode capture session (`--capture-dir`, VAD on, defaults), same
mic prerequisites as Phase 2 (macOS mic mode "Standard", built-in mic):

1. Repeat the Phase 2 script — fox sentence + "mic test one two" × 3.
2. Then ~3 s of deliberate keyboard typing and a door slam or hand clap.
3. Analyze with the updated analyzer (it now attributes silences three ways:
   benign / **VAD-gated (intentional)** / dropout).

Acceptance: clipped tails still 0; garble-attributed dropouts collapse
versus the Phase 2 Session A baseline; the typing and clap read as
**VAD-gated** silences, not dropouts. (Local mock rehearsal of exactly this
protocol: gate opened only for the two spoken sections, typing+clap span
attributed VAD-gated, 0 clipped tails, 0 dropouts.)

## Phase 4 — Live tuning console (engine-aware)

The `/livekit-test` page has a **Tuning** card whose knobs apply mid-session
through the agent. It is **engine-aware**: the knob set renders entirely from
the agent's `agent_config` broadcast, keyed by engine — a `tts` agent shows the
ElevenLabs knobs, an `rvc` agent shows the old set. No knob list, ranges, or
engine assumptions are baked into the frontend; `knobs.py` is the single source
of truth and the registry carries per-knob display metadata.

**RVC engine (parked baseline):**

| knob | range | default | applies |
|---|---|---|---|
| index_rate | 0–1 | 0.75 | RVC, mid-stream |
| protect | 0–0.5 | 0.33 | RVC, mid-stream |
| rms_mix_rate | 0–1 | 0.25 | RVC, mid-stream |
| f0_method | rmvpe/harvest/crepe/pm | rmvpe | RVC, mid-stream |
| prime_hops | 0.5–4 | 1.5 | agent, instant (next re-prime) |
| vad_threshold | 0–1 | 0.5 | agent, instant |
| vad_hangover_ms | 0–2000 | 300 | agent, instant |

Server-verified (OpenVoiceChanger backend @ `4cee7ef`): JSON text frames merge
into connection state on the open socket — **RVC knobs apply mid-stream, no
reconnect**. f0 methods are the ones the server actually runs; dio (aliased to
pm) and fcpe (conditional) are deliberately not offered.

**TTS engine (`--engine tts`, verified against ElevenLabs docs 29 Jul 2026):**

| knob | kind / range | default | applies | notes |
|---|---|---|---|---|
| voice | account voices (dynamic) | ELEVENLABS_VOICE_ID | next utterance | clones + premade; switching resets continuity + loads the voice's own settings |
| tts_model | flash_v2_5 / multilingual_v2 / v3 | flash_v2_5 | next utterance | |
| stability | 0–1 | 0.5 | next utterance | v3 reads it as ~0 Creative / 0.5 Natural / 1 Robust |
| similarity_boost | 0–1 | 0.75 | next utterance | slight latency cost; **not on v3** |
| style | 0–1 | 0.0 | next utterance | ⚡ >0 adds latency + can reduce stability; v2+/v3 only |
| use_speaker_boost | bool | on | next utterance | slight latency cost; **not on v3** |
| speed | 0.25–4.0 | 1.0 | next utterance | usable ~0.7–1.2; all models |
| request_continuity | bool | on | next utterance | request stitching (previous_request_ids) so delivery holds across a session; **not on v3** |
| prime_hops / vad_threshold / vad_hangover_ms | (shared) | — | instant | shared pipeline knobs |
| min_speech_ms | 0–1000 | 200 | instant | gate-open spans with less speech are dropped as blips (no STT call) |
| queue_wait_warn_ms | 0–5000 | 250 | instant | diagnostic only — a log threshold, not audio |
| comfort_noise_db | -80…-40 dBFS | -60 | instant | low-level room-tone bed under gate-closed silence so gaps don't feel dead; -80 = off |
| loudness_normalize | bool | on | next utterance | level each utterance to the target (RMS + soft limiter, never clips); off = raw synthesis |
| loudness_target_db | -40…-12 dBFS | -20 | next utterance | RMS target; ~-20 dBFS is a natural speech level |
| tts_chars | 0…ceiling (dynamic) | `SPIKE_MAX_TTS_CHARS` | instant | session synthesis cap; slider max = the env-only ceiling (the wall) |
| stt_seconds | 0…ceiling (dynamic) | `SPIKE_MAX_STT_SECONDS` | instant | session transcription cap; slider max = the env-only ceiling |

Voice settings are per-request: they take effect on the **next utterance** (the
UI labels this). Per-model support is enforced both ways — a knob a model
doesn't support (`similarity_boost` / `use_speaker_boost` / `request_continuity`
on `eleven_v3`) renders **disabled with the reason** and the agent **rejects**
any attempt to set it, never silently ignored. `⚡` marks a documented latency
cost.

**Request continuity (ticket 1):** each utterance conditions on the previous
one's `request-id` (request stitching, verified against the ElevenLabs docs) so
a session holds one delivery instead of drifting in tone. It resets on session
end and on any voice/model change, and is skipped on `eleven_v3` (which the docs
say has no stitching). The live-transcript panel marks a stitched utterance.

**Voice selector (ticket 6):** the account's voices (`GET /v1/voices` — clones +
premade) are fetched agent-side (a free GET, never metered) and broadcast as the
`voice` knob's choices with display names; the browser never holds the vendor
key. Switching resets continuity and loads the NEW voice's own default settings
(the applied-truth broadcast shows what's in effect for it). The **Voices**
button refreshes the list. `ELEVENLABS_VOICE_ID` stays the startup default; the
selector overrides per-session and never writes back to secrets. Export pins the
voice_id + name. (The shared community Voice Library is a separate surface —
`/v1/shared-voices` + an add step — and is out of scope here.)

**Comfort noise:** a low-level shaped-noise bed under gate-closed silence so
conversational gaps don't feel like a dead line. It crossfades at utterance
boundaries and, at -80 dBFS, is exactly digital zero (off). The analyzer is told
the bed level (from the capture config) so it classifies the bed as intentional
silence, never a dropout.

**Loudness normalization (post-Stage-1 ticket 1):** each utterance is measured
and leveled to `loudness_target_db` (RMS) before it is enqueued, with a soft
limiter that can never clip — fixing the volume sag between consecutive
utterances (request continuity holds tone, but Speaker Boost is not a level
control). **RMS, not integrated LUFS:** BS.1770/EBU R128 integrated loudness is
defined for program-length material — its 400 ms gating blocks and -10 LU
relative gate go unstable on short utterances — and the problem is the relative
level of ONE stationary voice, which RMS tracks directly (K-weighting earns its
keep across DIFFERENT spectra, not here). The whole short utterance is buffered
so its RMS is exact; `tts_ttfb_ms` still marks the vendor's first chunk and the
added enqueue wait is reported per utterance as `enqueue_delay_ms`. Off ⇒ the
original chunk streaming, byte-identical. See `loudness.py`.

**Governor caps → console knobs, walled by an env-only ceiling (post-Stage-1
ticket 2 — this REVERSES the earlier "caps stay env-only, no sliders" ruling):**
the session caps are now the `tts_chars` / `stt_seconds` sliders, so the budget
can be retuned mid-drill without a restart. The financial guardrail is preserved
by a two-layer design:

| layer | source | mutable? | role |
|---|---|---|---|
| cap | `SPIKE_MAX_TTS_CHARS` | console knob | the live session budget |
| **ceiling** | `SPIKE_MAX_TTS_CHARS_CEILING` | **env-only** | the wall — clamped server-side, client can never breach |

The ceiling **defaults to the starting cap**, so without a deliberate override
the console can only ever *lower* spend — an unattended run still cannot spend
more than today. Any set above the ceiling is clamped and reported with the same
three-way disposition as every knob. To open headroom for a long **tuning
session**, raise the wall (env-only) and, optionally, the starting cap:

```bash
export SPIKE_MAX_TTS_CHARS_CEILING=50000   # the wall (env-only); default = the cap
export SPIKE_MAX_STT_SECONDS_CEILING=3000
export SPIKE_MAX_TTS_CHARS=50000           # starting cap ≤ ceiling; default 5000
export SPIKE_MAX_STT_SECONDS=3000
```

Protocol: browser sends `{"type":"set_config","params":{...}}`; the agent
clamps out-of-range values, rejects garbage / unsupported-by-model / wrong-
engine knobs (never crashes), applies, writes a `config_change` event with the
FULL applied snapshot into meta.jsonl (when capturing), and broadcasts
`{"type":"agent_config","engine":...,"app_version":...,"config":...,
"defaults":...,"ranges":...,"metadata":...,"spend":...}`. The UI renders
confirmed badges ONLY from that broadcast — green match / amber mismatch /
muted unknown.

### Config-as-code: `tts_profile.json` + Export

Startup config resolves highest-wins: **CLI/env > `agent/tts_profile.json` >
the clone's own fetched settings > registry defaults** (logged at startup). The
committed profile is the lock-in mechanism: "locking in" the CEO's ear-found
config = editing `voice_settings` in that one JSON and committing it via PR —
reviewable, no code edit. A malformed profile is fatal (not silently reverted).

The console's **Export JSON** downloads the CURRENT AGENT-CONFIRMED config
(never raw slider state) plus metadata (timestamp, engine, model, app version)
in exactly the shape the profile loader reads back — so export → commit → load
round-trips.

### Live transcript panel

In tts mode the console shows, per utterance, **what STT heard** plus the
timing breakdown (stt / ttfb / tail ms, chars, model, WER), streamed over the
existing data channel. Tune VAD and voice settings **by ear against the
transcript** — the evidence that used to live only in the VPS log.

### Warm-on-join

A participant joining re-fires a real one-character warmup **synthesis**
(metered), not the keepalive GET ping — only a synthesis warms the vendor voice
model. VPS drill: the first utterance after a long idle paid ~2220 ms TTFB vs
~100 ms steady; the keepalive from process start does not survive hours of idle.

### Tuning protocol (A/B method)

1. Convert mode, capture on, mic prerequisites as in Phase 2/3.
2. Change **ONE** knob from defaults.
3. Speak the fixed script (or free-talk) and read the live transcript panel.
4. Score it (ear + analyzer report for that config segment).
5. **Revert to defaults** before the next knob; **Export JSON** to lock a keeper in.

Change one variable at a time — the capture's `config_change` events pin every
segment to its exact config, so post-hoc attribution is automatic.

**Continuity check (ticket 1):** to hear whether request continuity is holding,
speak the **same sentence three times** with a pause between each so the gate
closes and each is endpointed separately. With continuity **on**, the three
readings should hold **one delivery** (the panel marks the 2nd and 3rd
"stitched"); with it **off**, tone can drift between them. It is the direct A/B
for the tone-drift the CEO's session found — and it is inert on `eleven_v3`,
which has no stitching.

**Loudness check (ticket 1):** speak several utterances of visibly different
length/energy (a long sentence, then "yes.", then a medium one). With
`loudness_normalize` **on**, they should land at a consistent level; **off**,
the shorter/quieter ones sag. The per-utterance leveling (in → gain → out dBFS)
rides the transcript panel as `lvl`; the small buffering cost normalization
trades for exact level is recorded as `enqueue_delay_ms` in the capture.

## STT→TTS engine (`--engine tts`, the DEFAULT since 28 Jul 2026)

Instead of converting frames, it transcribes each utterance (ElevenLabs
Scribe v2 Realtime) and re-speaks it in the cloned voice (ElevenLabs TTS).
**This is the default engine.** `--engine rvc` remains the parked baseline and
fallback — unchanged, fully supported, nothing removed; in tts mode the RVC
client is never constructed. Startup runs a positive preflight before joining a
room (see the deploy section below).

```bash
# --engine tts is the default; shown explicitly here for clarity
./.venv/bin/python convert_agent.py --engine tts --mode convert \
    --tts-model eleven_flash_v2_5 \
    --capture-dir captures --drill-script drill_script.txt \
    --report report.json [--run-seconds 70]

# scripted E2E: publish a WAV into the room as a real-time participant
./.venv/bin/python publish_wav.py drill_48k.wav --room luminastream-spike
```

**Two rooms at once (post-Stage-1 ticket 3):** `--room` is a first-class flag
(env `LIVEKIT_ROOM`) and is logged in a banner at startup, so two agent
processes can serve two rooms concurrently — the manual two-session test:

```bash
LIVEKIT_ROOM=room-A ./.venv/bin/python convert_agent.py &   # terminal 1
LIVEKIT_ROOM=room-B ./.venv/bin/python convert_agent.py &   # terminal 2
#   ══════ convert agent · engine=tts · ROOM='room-A' · identity=... ══════
```

Needs `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` in the repo-root
`secrets.env`. **Every billable call is capped per run** by `spend_governor.py`
(`SPIKE_MAX_TTS_CHARS`, default 5000; `SPIKE_MAX_STT_SECONDS`, default 300);
an utterance that would exceed a cap is skipped whole, never truncated, and
logs `[governor] utterance skipped (would exceed cap)`. Voice expressiveness is
env-tunable via `SPIKE_TTS_STABILITY` / `SPIKE_TTS_SIMILARITY_BOOST` /
`SPIKE_TTS_STYLE` / `SPIKE_TTS_SPEED` / `SPIKE_TTS_SPEAKER_BOOST`.

`--engine tts` refuses `--no-vad`: the gate *is* the utterance endpointer.

### Measured performance (recommended config)

`eleven_flash_v2_5`, `--tts-hangover-ms 200`, agent on a Starlink-connected Mac:

| | scripted drill | live conversation (86 utterances) |
|---|---|---|
| tail_latency p50 | 932–954 ms | 1001 ms |
| p90 | — | 1111 ms |
| p95 | 949–1009 ms | 1920 ms |
| STT (commit→final) | ~315 ms | p50 318, max 406 ms |
| TTS TTFB | ~350 ms | p50 344 ms |

Cost: **~990 characters billed per minute of speech** (plus STT seconds), so
this account's 658,988-char monthly quota is roughly 11 hours of speech.

Two things to know about those numbers before planning against them:

- **~400 ms of the p50 is network round-trip** to a US vendor over Starlink
  (measured: 200 ms TCP connect, 433 ms TLS). Running the agent on the VPS
  should land p50 near 550–650 ms with no code change — the single biggest
  remaining lever.
- **The p95 gap in live conversation is structural, not a defect.** Synthesized
  audio takes about as long to play as the speech took to say, so continuous
  talking accumulates a backlog that drains at pauses. Any video-sync budget
  must be elastic, not fixed.

### VPS deploy (Amy, by hand)

```bash
# 1. Pull and install
cd ~/luminastreamv1 && git pull
cd agent && ./.venv/bin/python -m pip install -r requirements.txt

# 2. Add the TWO new secrets to the repo-root secrets.env (hand-typed;
#    never committed — secrets.env is gitignored)
#      ELEVENLABS_API_KEY=...
#      ELEVENLABS_VOICE_ID=...

# 3. Preflight — proves key, voice, network, quota and audio format BEFORE
#    anyone speaks. Exits 2 with a plain-English reason if anything is wrong.
./.venv/bin/python convert_agent.py --engine tts --run-seconds 1
#   expect:  STT READY (scribe_v2_realtime)
#            TTS READY (TTFB ... ms) — model=eleven_flash_v2_5 voice=...
#            PREFLIGHT OK — engine=tts ...

# 4. Launch (recommended config)
./.venv/bin/python convert_agent.py --engine tts --mode convert \
    --tts-model eleven_flash_v2_5 --tts-hangover-ms 200 \
    --capture-dir captures --report report.json
```

`lk_smoke.py` must print `CONNECTED OK` first on any new host, as always.
Spend is capped per run at 5000 chars / 300 s; raise deliberately with
`SPIKE_MAX_TTS_CHARS` / `SPIKE_MAX_STT_SECONDS`.

### Evaluating the aggressive 100 ms variant (free-talk protocol)

`--tts-hangover-ms 100` is ~150 ms faster (p50 787 ms) and **the scripted drill
cannot tell you whether it is safe** — the drill's lines are separated by 1.6 s
of silence, while natural speech pauses mid-sentence for 100–300 ms. Only
free conversation exposes the risk.

1. Headphones (the output feeds the mic otherwise and the agent transcribes
   itself in a loop). macOS mic mode **Standard**, built-in mic.
2. Run at `--tts-hangover-ms 200`. **Talk normally for 2–3 minutes** — full
   sentences with natural mid-sentence pauses, not drill lines.
3. Restart at `--tts-hangover-ms 100`. Same kind of talking.
4. The question is **not** "is it faster" (it is). It is: **do your sentences
   come back in one piece?** If a mid-sentence pause splits one sentence into
   two separately-spoken fragments with a prosody break, 100 ms is too
   aggressive and 200 ms is the answer.

**Full architecture, live API-verification tables, the optimization experiment
ledger and the per-model drill protocol live in [`SPIKE.md`](../SPIKE.md).**

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
