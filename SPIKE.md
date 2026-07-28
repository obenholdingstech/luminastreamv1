# SPIKE — STT→TTS voice engine (`--engine tts`)

**Status: EXPERIMENTAL. Branch `feat/spike-stt-tts`, opened as a DRAFT PR.
Merging is not the goal — the goal is an answered question.**

The question: instead of converting Amy's voice frame-by-frame (RVC), what if
we *transcribe* what she says and *re-speak* it in her cloned ElevenLabs voice?
That trades a continuous signal-processing pipeline for a discrete
utterance-at-a-time one, and the trade has a price. This spike measures the
price.

The short answer is in [Results](#results): the audio quality is excellent and
the transcript fidelity is near-perfect, but **tail latency lands around
1.5–2.4 s** — an order of magnitude above the RVC path's ~200 ms, and firmly
outside a live-conversation budget. This is not a tuning problem; it is
structural, and [where the time goes](#where-the-time-actually-goes) explains
why.

---

## How it fits the existing agent

`--engine rvc` is the default and is **completely untouched** — in tts mode the
RVC client is never constructed (no socket, no warmup, no GPU). Everything
before and after the engine is shared:

```
LiveKit ──► AudioStream ──► WindowAssembler ──► Silero VAD gate
                                                     │
                    ┌────────────────────────────────┴───────────────────┐
                    │ --engine rvc (default, unchanged)                  │
                    │   speech hops ──► RVC websocket ──► SolaStitcher   │
                    ├────────────────────────────────────────────────────┤
                    │ --engine tts (SPIKE)                               │
                    │   gate OPEN  ──► buffer the utterance              │
                    │   gate CLOSE ──► Scribe v2 Realtime ──► transcript │
                    │                  └► ElevenLabs TTS ──► PcmQueue    │
                    └────────────────────────────────┬───────────────────┘
                                                     │
                              OutputGate ──► AudioSource ──► LiveKit
```

**The VAD gate changes job, not behavior.** In RVC mode it is a noise gate. In
TTS mode the identical per-hop decision becomes an *utterance endpointer*: its
open→closed transition means "a complete thought was spoken." The Phase 3/4
tuning knobs (`vad_threshold`, `vad_hangover_ms`) therefore keep their exact
meaning across both engines.

`OutputGate` and the publisher are reused **unchanged**. Only the jitter buffer
swaps, to a contiguous `PcmQueue`:

> `SolaStitcher` exists to splice *overlapping* re-converted windows, searching
> for the best phase alignment between a new window and the tail already
> emitted. Synthesized TTS audio is contiguous by construction — consecutive
> chunks are literally the next samples of one waveform. Running SOLA over them
> would hunt for a correlation peak that means nothing and crossfade a signal
> onto a shifted copy of itself, i.e. manufacture comb filtering out of clean
> audio. `PcmQueue` also drops SolaStitcher's held-back `XFADE` tail (1024
> samples ≈ 21 ms of structural delay) since nothing will ever rewrite
> already-queued samples.

### Files

| file | role |
|---|---|
| `agent/spend_governor.py` | hard per-run spend caps — **written before any API call existed** |
| `agent/elevenlabs_client.py` | `SttClient` (realtime WS) + `TtsClient` (HTTP stream) |
| `agent/endpointer.py` | `UtteranceEndpointer` (input buffer) + `PcmQueue` (output buffer) |
| `agent/tts_engine.py` | utterance lifecycle, metrics, fail-open policy |
| `agent/wer.py` | transcript fidelity scoring against the drill script |
| `agent/publish_wav.py` | E2E harness: publishes a WAV into a room in real time |
| `agent/drill_script.txt` | the fixed drill script |

---

## The spend governor (guardrail first)

ElevenLabs bills per synthesized character and this agent runs autonomously
against a funded account. The governor was written and tested *before any
billable call existed in the codebase*, so an unattended loop is physically
unable to drain the account.

Two independent per-run meters, both env-overridable:

| meter | env | default |
|---|---|---|
| characters submitted for synthesis | `SPIKE_MAX_TTS_CHARS` | 5000 |
| seconds of audio submitted for STT | `SPIKE_MAX_STT_SECONDS` | 300 |

Semantics that matter:

- **Financial only, and it NEVER truncates.** If an utterance does not fit the
  remaining budget it is skipped **whole**, the meter is left untouched, and
  the caller drops it. There is deliberately no API to synthesize the
  affordable prefix — a half-spoken sentence is a corrupt experimental result
  that looks exactly like a pipeline bug.
- **A tripped cap is unmistakable.** Refusals log at ERROR with the fixed
  marker `[governor] utterance skipped (would exceed cap)` plus the arithmetic.
  Nothing else in the codebase logs that string, so *"out of budget, or broken
  pipeline?"* is always answerable by grep. It is also announced on the data
  channel.
- **The agent stays alive.** A refusal is not a latch — a short utterance can
  still pass after a long one was refused.
- **Malformed env override is fatal.** `SPIKE_MAX_TTS_CHARS=unlimited` exits
  rather than falling back to a default; a guardrail that quietly reverts is a
  rumor.
- Caps are per-process-run and are **not** persisted across restarts. Each
  model in a multi-run drill therefore gets a fresh budget — deliberate, but
  worth knowing before scripting a long unattended sweep.

---

## API verification (live, 28 Jul 2026)

Everything below was measured against the real API rather than taken from the
docs; model IDs come from `GET /v1/models` and the voice from
`ELEVENLABS_VOICE_ID`, never hardcoded. Account tier: **pro**.

### TTS transport — HTTP `/stream` wins, and it is the only universal one

TTFB for the same sentence, `output_format=pcm_48000`, warm connection:

| model | HTTP `/stream` | WebSocket `/stream-input` |
|---|---|---|
| `eleven_flash_v2_5` | **365 ms** | 642 ms |
| `eleven_multilingual_v2` | **900 ms** | 2460 ms |
| `eleven_v3` | **719 ms** | ✗ rejected at handshake |

The `stream-input` WebSocket exists to accept text that is *still being
produced* (by an LLM), buffering it against a `chunk_length_schedule`. We have
the complete transcript the instant STT returns, so that buffering is pure
added latency. HTTP also turned out to be the only transport that accepts
`eleven_v3` at all.

**Trap worth recording:** `output_format` is a **query parameter**. Passed in
the JSON body it is silently ignored and the response is default 128 kbps MP3 —
which, fed into a PCM path, costs the same and decodes to plausible-looking
garbage. It was caught only by noticing that 36 KB could not be 2.3 s of 48 kHz
PCM. `pcm_48000` is accepted on this account, so synthesis enters the existing
48 kHz mono output path with **no resampling at all**.

### STT — `scribe_v2_realtime`, uploaded at 16 kHz

| approach | latency to final |
|---|---|
| POST `/v1/speech-to-text`, `scribe_v2` | 2136 ms |
| POST `/v1/speech-to-text`, `scribe_v1` | 892 ms |
| realtime WS, `scribe_v2_realtime`, 48 kHz upload | 1463 ms (p50) |
| realtime WS, `scribe_v2_realtime`, **16 kHz upload** | **871 ms (p50)** |

Two findings drove the design:

1. **`scribe_v2_realtime` is the only model the realtime socket accepts.** The
   batch IDs (`scribe_v2`, `scribe_v1`) connect happily and then never emit a
   transcript. It also returned better punctuation than the batch endpoint.
2. **Uploading at 16 kHz is a 40% latency win.** The payload is 3.0× smaller
   (218 KB → 73 KB for a 2.3 s utterance) and the transcript is byte-identical.
   STT models run at 16 kHz internally, so the 48 kHz upload was spending
   uplink bandwidth to deliver information the model discards. The decimation
   reuses `vad.py`'s already-proven `Resampler48to16` rather than a second
   implementation.

The STT session is **persistent** (handshake measured ~900 ms, which would
otherwise land inside every utterance's tail latency) and reconnects on drop.
Nothing is ever sent while the gate is open — the buffered utterance is
burst-uploaded at gate-close with `commit=True` on the final chunk, giving
exactly one commit per utterance.

**Deepgram (runner-up, not used):** Nova-3 streaming is a credible alternative,
but it means a second vendor, a second key and a second billing surface for the
governor to cover — and ElevenLabs' own FLEURS numbers already put Scribe v2
ahead of Nova-3 on accuracy. One vendor, one key, one meter was worth more to
this spike than a marginal latency difference.

### Expressiveness knobs

`voice_settings` defaults are **the clone's own settings**, fetched from
`GET /v1/voices/{id}` at startup (stability 0.71, similarity_boost 0.91,
style 0.03, speaker_boost on) — the clone is the declared quality reference, so
env overrides deviate from *its* baseline rather than from invented numbers.
Each is overridable and every one is logged per utterance alongside `model_id`:

`SPIKE_TTS_STABILITY`, `SPIKE_TTS_SIMILARITY_BOOST`, `SPIKE_TTS_STYLE`,
`SPIKE_TTS_SPEED`, `SPIKE_TTS_SPEAKER_BOOST`

> **Voice ID note:** `ELEVENLABS_VOICE_ID` in `secrets.env` resolves to a cloned
> voice named **"Celebrity lilcrush linda"** (category `cloned`, an instant
> clone — `fine_tuning.state` is empty, so it is IVC not PVC), not one named
> "Amy". It is the ID the brief specified, so it is what the spike used. Worth
> confirming it is the intended reference clone before scoring "is it ME?".

---

## Metrics

**`tail_latency`** — the headline. From the **last speech sample** (gate-close
*minus* the hangover the endpointer actually applied) to the **first
synthesized sample enqueued** on the jitter buffer.

Both halves of that definition are deliberate:

- *Minus the hangover*: the human stopped talking when the last speech hop
  ended, not when the gate finally closed ~384 ms later. Measuring from
  gate-close would flatter the result by exactly the hangover.
- *Enqueued, not audible*: the priming depth that follows (`prime_hops`, 1.5
  hops ≈ 192 ms by default) is an existing, separately-tunable property of the
  output path. Folding it in would measure the jitter buffer twice. **Real
  perceived delay is tail_latency + priming.**

Note the hangover audio **is** still sent to STT — trailing consonants live
there, and Phase 3 exists precisely so this pipeline never becomes a
word-clipper. It is included in the transcription and excluded from the clock.

Per utterance, into `meta.jsonl` and the JSON report: STT ms, transcript, TTS
TTFB ms, chars billed, `model_id`, `stt_model_id`, `voice_settings`, utterance
and speech durations, WER/CER against the drill script, and the running spend
snapshot. `--capture-dir` works in tts mode, and `analyze_capture.py` renders
utterance markers and a per-utterance table aligned to the waveforms.

---

## Running it

```bash
cd agent
# real APIs; caps default to 5000 chars / 300 s per run
./.venv/bin/python convert_agent.py --engine tts --mode convert \
    --tts-model eleven_flash_v2_5 \
    --capture-dir captures --drill-script drill_script.txt \
    --report report.json [--run-seconds 70]
```

Scripted E2E (real LiveKit, real APIs) — publish the drill WAV as a participant:

```bash
./.venv/bin/python publish_wav.py drill_48k.wav --room luminastream-spike
```

`--engine tts` refuses to start with `--no-vad`: in tts mode the gate *is* the
endpointer, so without it the gate never closes, no utterance is ever emitted,
and the buffer grows to the forced-cut bound burning STT budget on 30-second
slabs. If the VAD fails open mid-stream, the agent falls back to passthrough
(`vad_required_for_tts`) rather than spend money on garbage.

---

## Results

Live E2E, 28 Jul 2026: real LiveKit Cloud, real ElevenLabs, the 5-line drill
script published as a real-time participant (`publish_wav.py`, pacing drift
≤ 19 ms). One reading per model, 5 utterances each, 12.8 s of speech per run.
`vad_threshold=0.5`, `vad_hangover_ms=300` (384 ms effective), `prime_hops=1.5`.

### Latency by model

| model | tail_latency p50 | p95 | TTS TTFB p50 | STT p50 | utterances |
|---|---|---|---|---|---|
| `eleven_flash_v2_5` | **1938 ms** | 2511 ms | 372 ms | 1121 ms | 5 |
| `eleven_v3` | 2459 ms | 2850 ms | 734 ms | 1015 ms | 5 |
| `eleven_multilingual_v2` | 2741 ms | 3071 ms | 942 ms | 1162 ms | 5 |

0 utterances skipped, 0 dropped, 0 underruns, 0 clipped tails, max utterance
queue depth 1 across all three runs.

**The expected ordering was wrong.** `eleven_v3` was nominated as the
"ceiling probe" expected to miss the latency budget by the widest margin — but
it beat `eleven_multilingual_v2` on both TTFB (734 vs 942 ms) and tail latency
(2459 vs 2741 ms). The slowest model here is the *quality reference*, not the
ceiling probe. All three miss a conversational budget regardless, so this
reorders the shortlist rather than rescuing anything.

### Where the time actually goes

Taking the `eleven_flash_v2_5` p50 of ~1938 ms:

| component | ms | can it be reduced? |
|---|---|---|
| VAD hangover before the gate closes | 384 | yes, but it is tail protection — shortening it re-introduces the word-clipping Phase 3 fixed |
| STT upload + latency-to-final | ~1121 | already 40% better via the 16 kHz upload; the floor is the vendor's ~150 ms plus this link's RTT |
| TTS TTFB | ~372 | already the fastest model and transport |
| enqueue → audible (priming, `prime_hops` 1.5) | ~192 | yes, tunable, at the cost of underrun margin |

**~1.5 s of the ~1.9 s is vendor round trips on a serialized STT→TTS chain.**
No amount of buffer tuning touches that: the architecture cannot start
synthesizing until it has a transcript, and cannot transcribe until the speaker
has stopped. Compare the RVC path's ~200 ms, which never waits for an utterance
boundary at all. **This is the spike's answer: the STT→TTS engine is
structurally a turn-taking technology, not a live voice-conversion one.**

The one architectural lever not pulled here is streaming audio to STT *while
the gate is open*, so transcription finishes almost when speech does. That was
deliberately excluded — the brief specified (and the tests enforce) that
nothing is sent while the gate is open, one STT call per utterance. It is worth
perhaps 800–1000 ms of the STT component and is the obvious next experiment if
this direction is pursued.

### Transcript fidelity

Corpus WER **0.1458** (7 edits / 48 reference words), identical across all
three runs — and that number needs an asterisk twice over:

1. **WER cannot vary by TTS model in this architecture.** Transcription happens
   before the TTS model is ever consulted, so reporting WER per model is
   meaningless here. It is a property of `scribe_v2_realtime` alone.
2. **Every one of the 7 edits is orthographic, not a mishearing.** Line 4,
   *"Call me back on zero four one five, two seven three"*, came back as
   *"Call me back on 041-5273."* — semantically perfect, numerically correct,
   and scored 0.6364 because WER compares word tokens. The other four lines
   scored **0.0000 exactly**. Real WER on this material is 0/37.

That digit normalization is a genuine finding rather than a scoring artifact to
wave away: the transcript is what gets re-spoken, so TTS will pronounce
"041-5273" using its own number normalization, which may or may not match how
the speaker said it. For phone numbers and IDs it is a real behavioral risk.

**Caveat on accent robustness:** the probe audio is *synthesized* clean speech
(a stock ElevenLabs voice, deliberately different from the clone so input and
output are distinguishable by ear). Near-zero WER on clean synthetic speech is
a **floor, not a result**. Accent robustness is exactly what Amy's live drill
reading measures, and it is the number that matters — see the drill protocol
below.

### Cost

Measured **~990 characters billed per minute of speech** (213 chars for 12.8 s,
consistent across all three runs). On this account's 658,988-character monthly
quota that is roughly **11 hours of speech per month**, plus STT seconds
metered separately. A full drill run costs 213 characters — about 0.03% of the
default 5000-character governor cap, so the caps never came close to binding
here (`refusals=0` in every run). They exist for the loop that goes wrong, not
this one.

### Verification

- **117 unit tests pass** (67 pre-existing, unchanged; 50 new), mock vendors
  only — no network, no spend.
- Governor: refusal commits nothing, never truncates, is not a latch, logs its
  fixed marker at ERROR, and a malformed env cap is fatal rather than silently
  defaulted.
- Endpointer: nothing leaves it while the gate is open, exactly one STT call
  per utterance, hangover audio included in the upload and excluded from the
  clock.
- Fail-open: STT error, TTS error, empty transcript, governor refusal and an
  unexpected exception each drop one utterance with a logged reason while the
  worker survives and the next utterance proceeds.
- Output: `PcmQueue` is sample-exact and contiguous; a 440 Hz sine reassembled
  through uneven chunks shows no step above its own derivative (no join clicks).
- `analyze_capture.py` renders the tts capture: 5 utterances, **0 clipped
  tails**, utterance markers aligned on the waveform timeline.

> **Analyzer note:** the pre-existing "DROPOUT → converter garbled" verdict
> assumes a frame-aligned converter. In tts mode the answer arrives seconds
> after the input, so output silence over active input is structural; those
> spans are now reported as `ENGINE-LATENCY` instead. Reading a tts capture
> with the old label would have manufactured a phantom bug.

---

## Amy's drill protocol

Same fixed script (`agent/drill_script.txt`), **one reading per model**, three
scores each. Change nothing between readings except `--tts-model`.

1. Mic prerequisites as in Phase 2/3 — macOS mic mode **Standard** (not Voice
   Isolation), built-in mic or closed headphones, no AirPods.
2. Run the agent with `--engine tts --mode convert --capture-dir captures
   --drill-script drill_script.txt --report reports/<model>.json`.
3. Read all five lines, pausing ~1.5 s between them so the gate closes and each
   line is endpointed separately.
4. Score, out of 10 each:
   - **clean /10** — artefacts, glitches, join clicks, prosody breaks
   - **latency-feel /10** — how it *feels* to talk through, not the number
   - **"is it ME?" /10** — identity of the cloned voice against your own ear
5. Repeat for `eleven_flash_v2_5`, `eleven_multilingual_v2`, `eleven_v3`.

`eleven_multilingual_v2` is the declared quality reference (the clone's MMv2
output); the other two are judged against it. Record the three scores per model
alongside the run's `report.json`.

| model | clean /10 | latency-feel /10 | is it ME? /10 | notes |
|---|---|---|---|---|
| `eleven_flash_v2_5` | | | | |
| `eleven_multilingual_v2` | | | | (quality reference) |
| `eleven_v3` | | | | |
