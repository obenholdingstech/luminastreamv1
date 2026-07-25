# LuminaStream — Session Log

Full session records, **newest at top**. Terse handover summaries live in `notes.md`.

---

## 24 July 2026, ~03:50 — Phase 3.1: VAD onnxruntime path + CPU-only torch diet

### Task (verbatim)

> the CTO has requested a Phase 3.1 micro-PR to fix the torch bloat and
> NNPACK log spam on the VPS convert agent.
> Switch the Silero VAD to its onnxruntime path (load_silero_vad(onnx=True)).
> Pin torch from the CPU-only index in requirements.txt to shed the gigabytes
> of unnecessary CUDA libraries.
> Verify against the installed package per our conventions, execute the
> fixes, and open the PR.
> before you commit or push anything, make sure you run
> git checkout -b fix/phase3-1-onnx-diet so this is on a clean branch

### Verified against the installed package (live, never memory)

- onnxruntime is an OPTIONAL silero-vad dep — not present until installed;
  pip resolves **1.19.2** on py3.9 (last line with cp39; also ships cp312
  for the VPS).
- `load_silero_vad(onnx=True)` → `OnnxWrapper`; **torch tensors still
  required** (numpy input rejected: AttributeError `.dim` — verified live),
  512-chunk rule and `reset_states()` identical to the JIT path.
- silero_vad.utils_vad imports torch at module level ⇒ torch cannot be
  dropped, only dieted: CPU-only wheels via
  `--extra-index-url https://download.pytorch.org/whl/cpu` with
  platform-marked pins (`2.8.0+cpu` on linux, plain `2.8.0` elsewhere —
  macOS has no +cpu builds). Wheel existence for cp312 x86_64 confirmed
  against the index.
- ONNX ≡ JIT numerically: zero-chunk prob 0.00167 both; fox sentence 99% of
  chunks ≥ 0.5; `VadGate().load()` → active, speech hop prob 1.0.
- NNPACK spam comes from TorchScript conv on unsupported VPS hardware —
  onnxruntime inference sidesteps it entirely.

### Changed

`agent/vad.py` (onnx=True + verified-contract docstrings),
`agent/requirements.txt` (extra-index, onnxruntime==1.19.2, platform-marked
torch/torchaudio CPU pins), session log, notes.md. 37/37 tests pass
(fail-open test monkeypatches the loader — unaffected by the backend swap).

### Task (abridged; full text in the PR)

> Gate the pipeline with Silero VAD on the VPS so only speech is sent to the
> RVC server; everything else becomes clean silence in the output. Verify the
> silero distribution/API before coding; per-hop gate; onset protection
> (context accumulates through gates — assert it); tail protection (300 ms
> hangover, flag-tunable); fail-open; --no-vad/--vad-threshold/
> --vad-hangover-ms; capture gate events; analyzer gains a third dropout
> attribution "VAD-gated (intentional)"; data-channel state backward-
> compatibly; gated hops enqueue nothing and are not drops. Test locally vs
> the mock; README Phase 3 section + acceptance protocol; atomic commits;
> PR via /opt/homebrew/bin/gh; await CodeRabbit and reply with evidence.

### Verified before coding (live docs + the venv, never memory)

- pip `silero-vad` **6.2.1** (Feb 2026) installs cleanly in agent/.venv
  (py3.9), pulling torch 2.8.0 + torchaudio 2.8.0 — all three pinned.
- API verified by introspection + live calls: `load_silero_vad(onnx=False)` →
  TorchScript model; `model(chunk, 16000)` returns a speech prob and
  **requires exactly 512-sample chunks** (256 rejected live); LSTM state kept
  across calls, `reset_states()` present; `VADIterator` default threshold
  0.5 → mirrored as our default (we implement hangover ourselves, calling
  the model directly per chunk).
- Geometry: HOP 6144 @48k = 2048 @16k = exactly 4 silero chunks per hop —
  gate decisions land on hop boundaries by construction.

### What was built (4 atomic commits)

1. `vad.py` + `SolaStitcher.drain()` + `test_vad.py` — `Resampler48to16`
   (FIR anti-aliased 3:1 decimation, filter state carried: chunked ==
   one-shot bit-identical), `VadGate` (max-prob threshold + hangover rounded
   UP to whole hops; fail-open on load/runtime error), `OutputGate`
   (fade-out drain of the stitcher tail at gate close — `drain()` releases
   the provisional XFADE tail, no underrun counting; silence while closed;
   re-prime + 15 ms equal-power fade-in at open; gate_open=True ==
   pre-Phase-3 behavior, proven byte-identical in a test).
2. convert_agent wiring — per-hop decision on `window[-HOP:]`; gated hops
   `continue` before the websocket (nothing enqueued, `gated` counter, not
   drops); assembler untouched by gating with a runtime seq-monotonicity
   assert; on output drain, in-flight windows from the closed period are
   marked stale by seq; fail-open published once on the data channel;
   `agent_mode` payload gains additive `vad` field; flags + startup config
   log; capture header + `vad_gate`/`vad_drained` events.
3. Analyzer third attribution — `gated_spans_from_events` (input-timeline
   spans, open-ended tail), `classify_silences` → benign / vad_gated /
   dropout, violet dropout-map shading, per-category report.
4. Classifier fix from E2E evidence — sparse transients (typing ≈ 9% of
   envelope frames) fell under the 30% activity bar and read as benign;
   gate-overlap is now checked first with a 5% floor.

### Verification

- **37/37 tests** (14 new). Deterministic stub prob_fn (sustained-energy,
  so impulses score 0 like real silero); assertions: gated spans exactly
  zero, hangover hops still sent, max sample-to-sample jump at gate edges
  0.014 (< 0.05 — no clicks), first post-gate window bit-equal to the raw
  input's last WINDOW samples (context continuity), fail-open pipeline ==
  ungated pipeline, OutputGate == legacy path when gate always open.
- **E2E vs mock with the REAL silero model** (fox → typing 3 s → clap →
  fox): gate opened only for the two spoken sections (prob 1.00 open /
  0.02 close), typing and clap never opened it; 49 windows sent vs 70
  gated; 0 drops, 0 stale, 0 underruns; analyzer: 0 clipped tails,
  0 dropouts, typing+clap span attributed **VAD-GATED 5.02–9.60s
  (intentional)**; dropout map renders the violet gated block; latency
  340→360 ms unchanged by gating.

### Files changed

New: `agent/vad.py`, `agent/test_vad.py`. Modified: `agent/bridge.py`
(drain), `agent/convert_agent.py`, `agent/analyze_capture.py`,
`agent/test_analyze.py`, `agent/requirements.txt`, `agent/README.md`,
`devlog/SESSIONS.md`, `notes.md`. Frontend untouched.

### CodeRabbit round (PR #10)

1 actionable + 5 nitpicks, all applied in c2e5ec4 (37/37 tests after):
notes.md stray kernel line labeled + verdict sentence completed; unused
`sent` → `_sent`; fail-open load test now exercises public `load()` via
monkeypatch; redundant `int(round())` removed; context-invariant assert →
explicit check + loud log (survives -O, keeps the stream alive); fail-open
publish task strongly referenced. Threaded reply + itemized evidence
comment posted on the PR.

### Task (verbatim)

> The CTO has reviewed your PR and requested the following mandatory updates on the current branch before merge:
>
> 1. THE "APPLIED TRUTH" UI FIX: The NS/EC/AGC readout currently renders React state (the requested constraints). Browsers frequently ignore these constraints silently. After publish and after each restartTrack, you must read `micTrack.mediaStreamTrack.getSettings()`, render the UI readout strictly from that actual state, and visually flag any mismatch between the button state and the applied state.
> 2. SECURITY HOTFIX: Add `CTO_HANDOVER*.md` to `.gitignore` immediately. The repo is public, and that file contains raw VPS IPs and port maps.
> 3. README PROTOCOL UPDATE: Add to the test protocol that macOS mic mode MUST be set to "Standard" (not Voice Isolation) via Control Center, and the user must use the built-in Mac microphone (no AirPods, to avoid headset DSP confounds).
> 4. GITHUB CLI PATH: You mentioned `gh` isn't installed. It is, but it's not on your PATH. Use the absolute path `/opt/homebrew/bin/gh` for your PR commands.
>
> Please push these changes to the existing Phase 2 branch, update the PR using `/opt/homebrew/bin/gh`, and await CodeRabbit's review.

### What was done

1. **Applied-truth readout** — hook gained `appliedConstraints` state read from
   `micTrack.mediaStreamTrack.getSettings()` after publish and after every
   `restartTrack` attempt (in `finally` — a failed restart still leaves a track
   whose real settings matter); cleared on disconnect/reset. The header readout
   now renders ONLY the applied state: green ✓/gray ✗ when it matches the
   buttons, **amber ⚠ with a requested-vs-applied tooltip on mismatch**,
   muted `NS–` when there is no live mic or the browser doesn't report a key.
2. **Security** — `CTO_HANDOVER*.md` added to the root `.gitignore`. Verified
   first: the file exists locally but was never tracked (`git ls-files` empty
   for it), so ignoring is sufficient — no history scrub needed.
3. **README protocol prereqs** — macOS mic mode MUST be "Standard" (Voice
   Isolation is OS-level DSP that clips tails upstream of the toggles) and
   built-in Mac mic only (no AirPods — onboard headset DSP is a second
   uncontrolled stage).
4. **gh works at `/opt/homebrew/bin/gh`** (it was installed since the earlier
   sessions' checks) — used for the PR update below.

### Verification

- eslint clean on both touched files; `vite build` clean; `tsc --noEmit` zero
  errors touching them. The applied-state read path (getSettings after
  publish/restart) was already live-proven by the Phase 2 headless-Chrome
  harness, which asserts on exactly those values.

### Files changed

`src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`, `.gitignore`,
`agent/README.md`, `devlog/SESSIONS.md`, `notes.md`.

### Task (verbatim)

> Phase 2 — capture-settings experiment (frontend only, then I run the pod session).
>
> Add audio-capture constraint controls to the LiveKit test page:
> - In src/hooks/useLiveKitVoice.js + src/pages/LiveKitTest.jsx ONLY: add three
>   toggles — noiseSuppression, echoCancellation, autoGainControl — default ON
>   (current browser behavior). Apply them as audio capture constraints when
>   publishing the mic track. BEFORE CODING: verify the exact constraint API
>   against installed livekit-client 2.20.1 (audioCaptureDefaults vs per-track
>   options — check the types, not memory).
> - Changing a toggle while connected should re-acquire/republish the mic with
>   the new constraints (or clearly require reconnect if the SDK demands it —
>   report which).
> - Show the active constraint state in the UI next to the mode indicator.
> - Update the agent README test protocol: the Phase 2 experiment is two
>   capture sessions (fox sentence + "mic test one two" x3), one with all
>   processing ON, one with all OFF, convert mode, --capture-dir enabled,
>   then analyze_capture.py on both and compare tail-clip reports.
> Branch → PR → CodeRabbit per convention. Log per CLAUDE.md.

### APIs verified against installed livekit-client 2.20.1 (types + live, never memory)

- `AudioCaptureOptions` (dist/src/room/track/options.d.ts:222) carries exactly
  `noiseSuppression` / `echoCancellation` / `autoGainControl` (ConstrainBoolean)
  plus deviceId etc. Two ways in: `RoomOptions.audioCaptureDefaults`
  (options.d.ts:35) or per-call — chose per-call:
  `setMicrophoneEnabled(enabled, options?: AudioCaptureOptions, publishOptions?)`
  (LocalParticipant.d.ts:100) since constraints can change per session.
- **Live toggle verdict: NO reconnect needed.**
  `LocalAudioTrack.restartTrack(options?: AudioCaptureOptions)`
  (LocalAudioTrack.d.ts:26) stops the old MediaStreamTrack, getUserMedias with
  the new constraints, and swaps via setMediaStreamTrack → sender.replaceTrack —
  publication and track SID survive.
- **Live-verified in headless Chrome** (fake mic, real LiveKit Cloud room, via a
  minimal harness page + result-POST server; no puppeteer on this machine):
  publish with all-ON → settings all true; restartTrack all-OFF → settings all
  false; back ON → all true; `trackSid` identical throughout; room stays
  connected. Chrome headless needed `--auto-accept-camera-and-microphone-capture`
  (the old fake-ui flag alone now yields NotAllowedError).
- Source-reading correction caught by the live test: I initially believed
  restartTrack dropped audio constraints without a deviceId (LocalTrack.restart
  maps audio to `audio: true` when constraints have no deviceId). Live run
  showed constraints DO apply — because `constraintsForOptions` injects
  `deviceId: {ideal:'default'}` when none is given, so the deviceId path is
  always taken. Real implication: without an explicit deviceId a toggle could
  silently jump to the system-default mic — so the hook pins the current device
  (`getSourceTrackSettings().deviceId`, fallback `getDeviceId(false)`) with
  `{exact: …}` on every restart.

### What was built (only the two allowed files + README)

- `useLiveKitVoice.js` — `captureConstraints` state (+ ref mirror), defaults
  all ON; `connect()` publishes with
  `setMicrophoneEnabled(true, {...captureConstraintsRef.current})`;
  `setCaptureConstraint(name, enabled)` updates state and, when connected,
  restarts the mic track in place with the device pinned; orphaned-room race
  guards match the file's existing pattern; getUserMedia failure during a
  restart surfaces via the existing `error` state.
- `LiveKitTest.jsx` — "Mic Processing" toggle row inside the Voice Mode card
  (three labeled on/off buttons, usable also while disconnected — they set the
  state for the next connect) + compact live state readout (NS✓ EC✓ AGC✓,
  green/gray) next to the agent-mode indicator.
- `agent/README.md` — Phase 2 experiment protocol: two convert-mode capture
  sessions (all-ON vs all-OFF), fox sentence + "mic test one two" ×3,
  `--capture-dir` on, analyze both, compare clipped-tail counts; hypothesis
  stated (browser processing eats word tails before the pipeline sees them).

### Verification results

- Headless-Chrome live run (above): 4/4 constraint states applied, same
  trackSid, room connected at end.
- eslint clean on both touched files; `vite build` clean; `tsc --noEmit`
  reports zero errors touching the two files (pre-existing errors elsewhere
  unchanged).

### Files changed

Modified: `src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`,
`agent/README.md`, `devlog/SESSIONS.md`, `notes.md`. Nothing else touched.

### Task (verbatim)

> Apply the four CodeRabbit findings on feat/capture-analysis-runbook before merge:
>
> 1. capture.py — bound the in-memory buffer (e.g. max ~60s of audio); if the
>    background writer task fails or the bound is hit, disable capture for the
>    session, log ONE loud warning with the reason, and free the buffers. The
>    agent's real-time loop must be unkillable by its own diagnostics.
> 2. capture.py — guard WAV size: cap capture at a sane max duration (or roll
>    to a new file); never write a header the format can't represent.
> 3. convert_agent.py — pop pending windows when discarded as stale so
>    turnaround/drop stats count each window exactly once. Add/extend a unit
>    test asserting no double-count on the stale path.
> 4. runbook.md — make the UFW commands real runnable lines, and pin the RVC
>    install to the exact commit we validated:
>    git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion@7b284a634667c34103eaaeed972b48ccdb4b893e
>    (add one line explaining WHY it's pinned: deterministic disaster recovery).
>
> Re-run the affected tests + one quick mock capture cycle to confirm the
> analyzer still reads cleanly. Reply to each CodeRabbit comment on the PR with
> what was done, per our convention. Push to the same branch.

### What was done

1. **capture.py self-defense** — new `_disable(reason)` path: sets `_dead`
   (every hot-path call becomes a no-op), frees ALL buffers, appends a single
   `capture_disabled` meta trace line, logs ONE `log.error`. Triggers:
   un-flushed audio > 60 s (`MAX_BUFFERED_BYTES`, tracked via
   `_pending_bytes` incremented on append / decremented on drain), pending
   meta lines > 200k, background-writer exception (previously it logged and
   the hot path kept appending forever — a slow leak), and the duration cap.
   Recursion guard: `_dead` is set before the trace line is appended.
2. **WAV size guard** — `MAX_CAPTURE_SECONDS = 3600` per stream; on hit,
   capture disables and the WAVs finalize with the audio captured so far
   (headers always patched with real sizes ≪ the 4 GiB uint32 RIFF limit).
   Bounds are per-instance attributes so tests can tighten them.
3. **Stale windows counted exactly once** — new
   `SessionCapture.window_stale(seq, reason)` pops the pending entry and
   emits a `stale` line WITH t_sent/turnaround; convert_agent's two stale
   branches now call it. Previously a stale window stayed in `_pending` and
   was double-reported as `window_lost` at close.
4. **runbook.md** — UFW is now five runnable lines (default deny incoming /
   allow outgoing / allow OpenSSH / --force enable / status verify) +
   `systemctl enable --now fail2ban`; RVC install pinned to commit
   `7b284a63…` with the why (deterministic disaster recovery; upstream moves).

### Verification

- **23/23 tests pass** — 3 new: stale-exactly-once (no `window_lost`, no
  `window` for stale seqs, turnaround present), buffer-bound disable (memory
  freed, all no-ops after), writer-failure disable (unwritable dir → `_dead`,
  no accumulation).
- Fresh mock capture cycle (convert mode, fox + typing probe): offset 340 ms
  (corr 0.981), 86/86 windows, turnaround p50/p95 77/155 ms, 0 clipped
  tails, 14/14 silences benign — analyzer reads the new meta format cleanly.
- py_compile clean.

### Files changed

`agent/capture.py`, `agent/convert_agent.py`, `agent/test_analyze.py`,
`runbook.md`, `devlog/SESSIONS.md`, `notes.md`.

### Blocked

- Replying to the CodeRabbit comments on the PR: `gh` is still not installed
  on this machine and API-credential use from the keychain is blocked by
  tool policy. Reply texts drafted in `agent/captures/PR_REPLIES.md`
  (gitignored) ready to paste.

### Task (verbatim)

> Phase 1 build — three deliverables on one branch. This is diagnostic
> infrastructure; nothing touches the real-time behavior of the pipeline
> unless capture is explicitly enabled.
>
> ── 1. CAPTURE MODE on convert_agent.py ──
> Add --capture-dir <path>. When set, each session writes a timestamped
> subdirectory containing:
>   - input_48k.wav  — mono 48k frames exactly as received from LiveKit
>     (post-AudioStream), BOTH modes. This is "what the pipeline received."
>   - output_48k.wav — frames as published back (passthrough: the passthrough
>     audio; convert: the stitched converted audio).
>   - meta.jsonl — one JSON line per event: session header (mode, RVC_WS_URL,
>     HOP/CTX/XFADE/SOLA, priming depth); per-window {seq, t_sent, t_recv,
>     turnaround_ms}; drops (with seq); underruns (with sample count);
>     stale discards; mode changes; jitter-buffer depth sampled every hop.
> CRITICAL: zero synchronous disk I/O in the frame loop — buffer in memory,
> flush via background task (aiofiles is already pinned). Capture must be
> provably inert when the flag is absent.
>
> ── 2. ANALYSIS SCRIPT agent/analyze_capture.py ──
> Takes a capture directory, produces:
>   - aligned waveform plot (input vs output, latency offset computed via
>     cross-correlation and reported in ms)
>   - spectrogram pair (this is where "chunky gibberish" becomes visible)
>   - RMS envelope overlay with utterance-tail comparison: flag any utterance
>     whose input tail energy has no corresponding output tail (the
>     word-clipping detector)
>   - dropout map: output silence regions annotated with meta.jsonl events
>     (drop/underrun markers on the timeline — starvation vs garbling)
>   - text report summarizing all of the above
> matplotlib as a new dep — add to requirements.txt (runs on the Mac; fine).
> Include a docstring documenting the test protocol: record "the quick brown
> fox jumps over the lazy dog" plus 3s of keyboard typing, in both modes.
>
> ── 3. HOUSEKEEPING ──
>   - Create agent/lk_smoke.py (portable: resolves secrets.env at repo root
>     relative to its own path; prints CONNECTED OK on success) and commit it.
>   - Create runbook.md at repo root: full disaster-recovery recipe. Sources:
>     devlog/SESSIONS.md + notes.md + these session facts that MUST appear:
>     POD: ubuntu2204/py3.10/cu118 community template (rehabc image) — NEVER
>     ubuntu2404 (RunPod runtime futex-crashes LiveKit Rust FFI; never run the
>     agent on RunPod at all). Deploy from volume koehrg7i63 (EU-RO-1),
>     /workspace mount. ALL ports at deploy time, never edit-after (edit →
>     restart → host slot lost to scheduler): HTTP 8888, TCP 22 + 8000.
>     TCP-direct is mandatory for agent↔RVC (Cloudflare proxy blocks
>     machine-to-machine WS upgrades); NAT external port CHANGES every
>     deploy — RVC_WS_URL must be refreshed. First commands: nvidia-smi;
>     apt install -y tmux (not on image). RVC venv rebuild recipe (glibc-
>     bound: pyworld compiles against image libc): uv venv --python 3.10 →
>     requirements → --no-deps git RVC → setuptools<80 → uv pip swap
>     onnxruntime→onnxruntime-gpu (.venv/bin/pip doesn't exist in uv venvs).
>     torch pin: requirements resolve cu13 > driver 12.8 → uv pip install
>     --reinstall "torch==2.8.*" "torchaudio==2.8.*" --index-url
>     https://download.pytorch.org/whl/cu128; verify torch.cuda.is_available().
>     Stateless launch (both RVC_STREAM_CONTEXT_SECONDS=0 spellings, tmux);
>     activation response MUST say "device":"cuda:0". Stop-not-Terminate
>     discipline. VPS: any real KVM VM, EU; setup = python3-venv git tmux,
>     non-root user, hand-typed secrets.env, agent venv, ufw+fail2ban;
>     GATE = lk_smoke.py CONNECTED OK before anything else. Agent launch in
>     tmux with current RVC_WS_URL.
>
> ── VERIFY ──
> Full capture→analyze cycle against the mock on this Mac: capture a spoken
> sentence + keyboard noise in both modes, run analyze_capture.py, confirm
> plots render, latency offset is sane (~375ms convert / ~0 passthrough),
> and meta events align with the timeline. Unit-test the tail-clip detector
> on synthetic data. Lint/build/typecheck no new errors. Branch → PR →
> CodeRabbit per convention. Log session per CLAUDE.md.

### What was built

- **`agent/capture.py`** (new) — `SessionCapture`: one instance per processing
  session, writing `<capture-dir>/<timestamp>/{input_48k.wav, output_48k.wav,
  meta.jsonl}`. Hot-path methods (`add_input`/`add_output`/`event`/`window_*`)
  are pure in-memory appends; ALL disk I/O (even mkdir) lives in one
  background task using aiofiles, flushing every 0.5 s. WAVs are written with
  a placeholder header patched with real sizes on close (abort-safe). Every
  meta line carries `t` (monotonic since session start) + `in_pos`/`out_pos`
  (sample positions) — the alignment keys the analyzer pins events with.
  Windows still in flight at close are recorded as `window_lost`.
- **`agent/convert_agent.py`** — `--capture-dir` flag; every hook is a single
  `if self.capture:` on a None when disabled. Events wired: session header
  (mode, RVC_WS_URL, HOP/CTX/XFADE/SOLA, prime depth), per-window
  {seq, t_sent, t_recv, turnaround_ms}, drop(seq), underrun(samples),
  stale(seq), mode_change, buffer_depth every hop (with in_flight).
  `aclose()` now awaits the cancelled process task so capture finalizes.
- **`agent/analyze_capture.py`** (new) — produces `aligned_waveforms.png`
  (min/max-decimated, offset via RMS-envelope cross-correlation),
  `spectrograms.png` (shared dB scale, output time-shifted), `rms_envelope.png`
  (utterance segmentation + tail-clip flags), `dropout_map.png` (silences
  classified **benign vs DROPOUT** by whether the aligned input was active;
  meta events pinned by out_pos), `report.txt`. Test protocol in the
  docstring (fox sentence + 3 s typing, both modes). Pure-math helpers
  (envelope/offset/utterances/tail-clips/silences/classification) have no I/O.
- **`agent/test_analyze.py`** (new) — 12 tests: offset recovery at exactly
  375 ms and 0 ms; utterance merge/blip rules; tail-clip detector — flagged
  when body survives but tail dies, NOT flagged when intact / whole-utterance
  loss (that's a dropout) / offset-shifted / beyond captured output; silence
  classification benign vs dropout; envelope values; SessionCapture end-to-end
  (valid WAVs, meta ordering, window_lost, alignment keys on every line).
- **`agent/lk_smoke.py`** (new) — portable connectivity gate: resolves
  secrets.env relative to its own path, mints its own token, `CONNECTED OK`
  + exit 0 / `FAIL` + exit 1. Identity `echo-smoke` so agents ignore it.
- **`runbook.md`** (new, repo root) — full disaster-recovery recipe (pod
  template/ports/TCP-direct/NAT-port-changes, uv venv rebuild + torch cu128
  pin, stateless launch + cuda:0 check, Stop-not-Terminate, VPS setup,
  lk_smoke gate, bring-up checklist, local mock fallback).
- Housekeeping: `captures/` gitignored; README got a capture section + a
  SUPERSEDED banner on the old "agent on the pod" RunPod runbook (agent must
  never run on RunPod); requirements.txt pins aiofiles==25.1.0 (was installed
  but unpinned) and matplotlib==3.9.4.

### Key findings / surprises

- aiofiles was claimed pinned but wasn't in requirements.txt (installed
  25.1.0 in the venv) — now actually pinned.
- A leftover mock_rvc_server.py from the morning session (system Python,
  PID 12597) was still holding port 8000; used it rather than killing it.
- Convert-mode offset measured **340 ms** by cross-correlation (vs ~375
  expected) — consistent with the jitter buffer riding slightly below 1.5
  hops that run (median depth 1.44 hops); passthrough measured exactly 0 ms,
  peak correlation 1.000.
- First-cut dropout report listed every inter-keystroke gap as a "silence
  region"; fixed by classifying output silences against the aligned input
  (benign when input silent too, DROPOUT only when audio went in and nothing
  came out).

### Files changed

New: `agent/capture.py`, `agent/analyze_capture.py`, `agent/test_analyze.py`,
`agent/lk_smoke.py`, `runbook.md`.
Modified: `agent/convert_agent.py`, `agent/requirements.txt`,
`agent/README.md`, `agent/.gitignore`, `devlog/SESSIONS.md`, `notes.md`.
Untouched: everything else (no frontend changes).

### Verification results

- Unit tests **20/20 pass** (12 new + 8 existing bridge tests).
- Full capture→analyze cycle vs the mock on LiveKit Cloud, macOS `say`
  speaking the fox sentence + 3 s synthetic keyboard transients published by
  a scripted real-time participant, one session per mode:
  - passthrough: offset **0 ms** (corr 1.000), 2 utterances, 0 clipped tails,
    all 14 silences benign, meta = header + session_end only.
  - convert: offset **340 ms** (corr 0.978), 86/86 windows returned,
    turnaround p50/p95 78/156 ms (mock is 70 ms + spikes), buffer median
    1.44 hops, 0 drops/underruns/stale, 0 clipped tails, 0 dropouts.
  - All four plots rendered and visually inspected — waveforms/spectrograms
    line up after the shift; meta events pin correctly to the timeline.
- Inertness: agent run WITHOUT the flag over the same probe — zero capture
  log lines, no directories written, stats identical (87/87 windows, 0 drops).
- `lk_smoke.py` → `CONNECTED OK`, exit 0.
- py_compile clean; eslint on the two frontend files clean; `vite build`
  clean (only the pre-existing chunk-size warning).

### Task (verbatim)

> Build the RVC conversion agent (Move 2b): transplant the proven
> agent/bridge_test_v3.py pipeline into a LiveKit agent with a LIVE
> passthrough/convert mode toggle.
>
> CONTEXT — read these files first:
> - agent/echo_agent.py = proven transport skeleton (room join, server-side
>   token from secrets.env, subscribe/republish, echo-* identity guard).
>   Keep it untouched as the known-good reference.
> - agent/bridge_test_v3.py = proven conversion recipe: stateless sliding
>   windows @48k mono (WINDOW 14336 = CTX 8192 + HOP 6144), warmup window
>   before live pacing, backpressure (max 2 in-flight, drop hops), SOLA-
>   aligned equal-power crossfade (XFADE 1024, SOLA 384, stride 8).
>   RVC WebSocket protocol: JSON config first {"sample_rate":48000,
>   "chunk_size":14336,"f0_method":"rmvpe","index_rate":0.75,"protect":0.33,
>   "rms_mix_rate":0.25,"filter_radius":3,"pitch_shift":0}, then binary
>   [uint32 seq][uint32 reserved][float32 PCM] both directions.
> - Production topology: agent runs on the same box as the RVC server
>   (RunPod), RVC_WS_URL=ws://127.0.0.1:8000/ws/audio. Server MUST run with
>   RVC_STREAM_CONTEXT_SECONDS=0 (stateless) — document in README.
>
> BEFORE CODING — verify against the installed packages (livekit 1.1.13
> Python, livekit-client 2.20.1 JS), never memory. Report what you find:
> 1. Data channels: exact Python receive API (event name, payload shape,
>    participant attribution) and JS publish API (signature, reliable flag),
>    plus Python->JS publish for confirmations.
> 2. rtc.AudioStream 48k mono frame cadence — confirm same as echo agent.
> 3. AudioSource.capture_frame flow control — confirm await = backpressure.
>
> BUILD:
> 1. agent/bridge.py — pure logic extracted from bridge_test_v3.py:
>    - WindowAssembler: feed 480-sample frames -> yields (seq, window[14336])
>      every 6144 new samples; zero-left-pad at stream start
>    - SolaStitcher: accepts converted windows (lengths may vary slightly,
>      ratio ~1.008 observed), SOLA-align + crossfade, exposes continuous
>      output readable in 480-sample frames; counts underruns
>    - All params constructor args with v3 defaults
>    - pytest unit tests: assembly bookkeeping; sine-wave chop/reassemble
>      must show no phase jumps; underrun behavior
> 2. agent/rvc_client.py — async RVC WS client: connect, config, warmup
>    exchange, send_window, receive loop, in-flight tracking, turnaround
>    stats, reconnect-on-drop (re-warmup on reconnect).
> 3. agent/mock_rvc_server.py — same WS protocol, echoes each window back
>    unchanged after configurable delay (default 70ms, occasional 150ms
>    spike). Purpose: full plumbing test on Mac without GPU.
> 4. agent/convert_agent.py — main agent, based on echo_agent structure:
>    - Modes: "passthrough" (frames straight through; RVC paused = GPU cost
>      control) | "convert" (frames -> WindowAssembler -> rvc_client ->
>      SolaStitcher -> frames out)
>    - Live switching via data messages {"type":"set_mode","mode":...};
>      agent confirms {"type":"agent_mode","mode":...}; re-send confirmation
>      when a participant joins
>    - Jitter buffer: drain converted output only after ~1.5 hops buffered;
>      underrun -> emit silence + count
>    - Backpressure: in-flight >= 2 -> drop hop, emit silence for it (late
>      audio is worse than lost audio)
>    - Startup: warmup RVC BEFORE joining the room (stream never sees a
>      cold model)
>    - Robustness: RVC connection failure in convert mode -> auto-fallback
>      to passthrough + {"type":"agent_mode","mode":"passthrough",
>      "reason":"rvc_unavailable"} + background retry
>    - Stats every 5s: mode, frames in/out, windows sent/recv/dropped,
>      underruns, turnaround p50/p95, buffer depth
>    - CLI/env: RVC_WS_URL, --mode (default passthrough), room/identity
>      same pattern as echo agent
> 5. Frontend — ONLY src/pages/LiveKitTest.jsx and
>    src/hooks/useLiveKitVoice.js: Passthrough|Convert toggle publishing
>    set_mode; "Agent mode: X" indicator driven by agent_mode confirmations
>    (agent is source of truth, not the button). Everything else intact.
> 6. agent/requirements.txt (pin additions: websockets, scipy, numpy as
>    needed) + agent/README.md: Mac mock runbook AND pod runbook (stateless
>    env var, activate model, launch agent).
>
> VERIFY LIVE (like the echo agent): on the Mac with mock server — connect,
> passthrough (hear yourself at ~echo latency), toggle convert (hear
> yourself + ~200ms pipeline latency, no plumbing stutter), toggle back,
> confirmations round-trip, stats sane, unit tests pass, lint/build clean,
> typecheck adds no NEW errors. Report: APIs verified, files changed,
> surprises, and the exact pod runbook.
>
> Do NOT modify echo_agent.py, useVoiceStream.js, or anything in base44/.

(Also this session: created `CLAUDE.md` session-logging convention — this file is its first entry.)

### APIs verified against installed packages (never memory)

- **Python receive (livekit 1.1.13):** room event `"data_received"` delivers one
  `DataPacket` dataclass — `.data: bytes`, `.kind`, `.participant:
  RemoteParticipant | None` (None when sent by a server SDK), `.topic`.
- **Python publish:** `await local_participant.publish_data(payload: bytes|str, *,
  reliable: bool = True, destination_identities: List[str] = [], topic: str = '')`
  — confirmed coroutine via `iscoroutinefunction`.
- **JS publish (livekit-client 2.20.1):** `publishData(data: Uint8Array, options?:
  DataPublishOptions): Promise<void>` with `DataPublishOptions = {reliable?:
  boolean, destinationIdentities?: string[], topic?: string}` (types.d.ts:46).
- **JS receive:** `RoomEvent.DataReceived → (payload: Uint8Array, participant?,
  kind?, topic?, encryptionType?)` (Room.d.ts:327).
- **AudioStream:** `from_track(track=, sample_rate=48000, num_channels=1,
  frame_size_ms=None…)` — same call as echo agent; 10 ms/480-sample cadence
  (observed live at 100 fps in Stage 1 and again this session).
- **capture_frame:** coroutine; docstring states it waits until the internal
  queue (default `queue_size_ms=1000`) has space — the await IS the backpressure.
- **Also verified before use:** `rtc.ConnectionState.CONN_CONNECTED`,
  `Room.connection_state`, and that `AudioFrame.create(...).data` is writable
  through `np.frombuffer`.

### What was built

- `agent/bridge.py` — pure logic, no LiveKit/network. `WindowAssembler`
  (arbitrary frame sizes → `(seq, window[14336])` every 6144 samples,
  zero-left-pad at start, **seq monotonic across reset()** so stale in-flight
  returns are discardable by seq). `SolaStitcher` (v3 math verbatim: last
  HOP+XFADE+2·SOLA of each window, stride-8 SOLA search, sin²/cos² equal-power
  crossfade) — streaming twist: the last XFADE samples are provisional (next
  window rewrites them), so they're **held back from readers**; whole-frame
  silence on underrun (no mid-frame splice click) + counters.
- `agent/test_bridge.py` — 8 pytest tests. Strongest: sine → assembler →
  identity-stitcher reproduces the input **exactly** (SOLA offsets land on the
  hop grid at 768); plus a ×1.008-stretched variant (continuity), underrun
  counting, holdback invariants, seq-across-reset.
- `agent/rvc_client.py` — async WS client; `connect()` always does
  config + zero-window warmup (so reconnect ⇒ re-warmup by construction);
  receive loop with in-flight tracking and p50/p95 turnaround; `on_disconnect`
  fires only for unexpected drops.
- `agent/mock_rvc_server.py` — same wire protocol; FIFO per connection
  (mirrors GPU serialization); 70 ms delay, 150 ms spike every 10th window;
  output resampled ×1.008 (scipy, 126/125) to exercise SOLA like the real server.
- `agent/convert_agent.py` — echo-agent skeleton + live mode toggle; jitter
  buffer primes at 1.5 hops; in-flight ≥ 2 → drop hop; RVC warmup before room
  join; auto-fallback to passthrough (`rvc_unavailable`) + 5 s background retry
  + auto-restore (`rvc_recovered`); 5 s stats; confirmations re-sent on every
  participant join. 1 frame in → 1 frame out keeps output paced by input.
- Frontend (only the two allowed files): `useLiveKitVoice.js` gained
  `agentMode`/`agentModeReason` state fed by `RoomEvent.DataReceived` and a
  fire-and-forget `requestAgentMode()`; `LiveKitTest.jsx` gained the
  Passthrough|Convert card — buttons only *request*, the indicator shows what
  the agent *confirmed*.
- `agent/requirements.txt` pinned additions: websockets 15.0.1, numpy 2.0.2,
  scipy 1.13.1, pytest 8.4.2. `agent/README.md`: Mac mock runbook + RunPod
  runbook (RVC_STREAM_CONTEXT_SECONDS=0 documented twice, incl. troubleshooting).

### Key findings / surprises

- **The venv trap:** `agent/.venv/bin/pip` is a `#!/bin/sh` trampoline whose
  absolute path points at a *OneDrive copy* of this repo — `pip install` was
  landing in the wrong site-packages. Fix: always `./.venv/bin/python -m pip`.
- **scipy first import took 40 s** (macOS scanning fresh .so files) — made the
  mock server look dead on first launch. One warm import fixes it forever.
- Measured added latency of convert mode is **~375 ms**, not the hoped ~200 ms:
  ≈ hop 128 + turnaround ~80 + jitter buffer ~170 (1.3–1.5 hops steady).
  With the Move 2a transport figure (185 ms) that's ~560 ms vs the 500 ms
  target — the priming depth (1.5 hops) and HOP are the tuning knobs, already
  flagged as the "flow tuning" follow-up in notes.md.
- Shutdown via SIGINT prints an asyncio "task exception never retrieved"
  traceback after "stopped by user" — cosmetic, matches the run-until-Ctrl-C
  pattern, zero runtime errors.

### Files changed

New: `agent/bridge.py`, `agent/test_bridge.py`, `agent/rvc_client.py`,
`agent/mock_rvc_server.py`, `agent/convert_agent.py`, `devlog/SESSIONS.md`.
Modified: `agent/requirements.txt`, `agent/README.md`,
`src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`, `CLAUDE.md`
(session-logging convention), `notes.md`.
Untouched as required: `echo_agent.py`, `useVoiceStream.js`, `base44/`.

### Verification results

- Unit tests: **8/8 pass**.
- Offline pipeline smoke (assembler → RvcClient → mock → stitcher, real-time
  paced sine): 62/62 windows, 0 drops, 0 underruns, p50/p95 79/159 ms,
  max sample jump 0.0286 (= pure sine derivative → zero splice artifacts).
- **Live E2E, 11/11 checks PASS** — mock + convert_agent + scripted LiveKit
  user (Python SDK, publishes real-time 440 Hz tone) on LiveKit Cloud:
  confirmation on join; passthrough echo rms 0.354, onset 408 ms; toggle →
  convert confirmed; convert audio rms 0.355, onset 783 ms, **0/250 silent
  slices (no stutter)**; mock killed mid-convert → `agent_mode passthrough /
  rvc_unavailable` auto-sent; mock restarted → `convert / rvc_recovered`
  auto-restored; toggle back confirmed. Agent stats sane throughout
  (frames in == out, buffer ~1.3 hops, turnaround p50/p95 81/158 ms, 0 drops,
  0 underruns, 0 stale).
- Frontend: eslint clean on both touched files (the repo's 1 pre-existing
  error in `VoiceMetricsPanel.jsx` — unused `Check` import — predates this
  session, confirmed via stash, and that file is out of scope); `vite build`
  clean; `tsc` reports no errors in the touched files (all pre-existing
  errors are in Register/ResetPassword/etc.).
- Human ear test still worth a minute: run the Mac runbook in
  `agent/README.md` and listen for the ~0.4 s echo in convert mode.
