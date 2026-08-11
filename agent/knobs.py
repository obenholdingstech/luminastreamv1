"""Tuning-knob registry — pure logic, no I/O.

Single source of truth for every live-tunable parameter: kind, range, default,
where it applies (`target`), which engine(s) it belongs to (`engines`), and the
display metadata the console renders from (label/step/group/timing/hint). Built
for RVC in Phase 4 and extended for `--engine tts` (28 Jul 2026 default flip).

`target` — HOW a knob applies:
  "rvc"    sent as a mid-stream JSON settings frame on the open RVC websocket
  "tts"    an ElevenLabs per-request property (voice_settings field or model);
           takes effect on the NEXT synthesized utterance
  "agent"  applied in-process, instantly

`engines` — WHERE a knob is valid. The console renders knob groups keyed by the
agent's broadcast engine, so a tts agent shows tts knobs and an rvc agent shows
the old set with no hardcoded engine assumptions in the frontend. Shared
pipeline knobs (prime_hops, the VAD pair) carry both engines. RVC knobs are
PARKED, not dead — `--engine rvc` is still fully supported.

Server-side RVC facts verified against OpenVoiceChanger backend @ 4cee7ef
(backend/routers/websocket.py + services/rvc_processor.py):
  - JSON text frames are accepted at ANY time on the open socket and merged
    into connection state; each audio frame re-reads them → mid-stream updates
    work, no reconnect needed
  - f0 methods actually supported: rmvpe / harvest / crepe / pm (dio aliased to
    pm; fcpe only when torchfcpe is present — both excluded)

ElevenLabs voice_settings facts verified against the live docs (29 Jul 2026),
quoted in the PR that added them:
  - stability/similarity_boost/style ∈ [0,1]; speed ∈ [0.25,4.0]; speaker_boost
    is boolean. Defaults 0.5 / 0.75 / 0.0 / 1.0 / true.
  - style is "v2+ and v3 models only" and >0 "consumes additional computational
    resources and might increase latency" and reduces stability.
  - Eleven v3 does NOT support similarity_boost ("Similarity is not available
    for the Eleven v3 model") or use_speaker_boost ("Speaker Boost is not
    available for the Eleven v3 model"). Those render DISABLED with the reason,
    never silently ignored.
  - speed is "available for all voices and all models".

clamp_params() is the fail-safety chokepoint: whatever arrives over the data
channel comes out as in-range applied values + a report of what was adjusted or
rejected. It never raises on malformed input. Per-MODEL validation (a voice
setting a model doesn't support) needs the live model and so lives in the apply
path; model_unsupported() is the pure predicate it calls.
"""

from bridge import HOP

F0_METHODS = ("rmvpe", "harvest", "crepe", "pm")

# ElevenLabs model ids exposed as a select. Verified against GET /v1/models and
# the model docs (29 Jul 2026): all three are current flagship TTS models.
TTS_MODELS = ("eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3")
DEFAULT_TTS_MODEL = "eleven_flash_v2_5"

# Per-model knob support. ONLY documented negatives are encoded — the frontend
# disables these with the reason, and the apply path rejects attempts to set
# them, so a model that ignores a knob never does so silently. The flash+style
# question is deliberately NOT encoded as a disable (see module docstring / PR):
# docs say style is "v2+ and v3 only" (would include flash v2.5) yet also that
# "Flash models ignore some voice settings for speed" without naming them —
# left supported-with-a-latency-hint and flagged for the ear drill rather than
# guessed. request_continuity (request stitching) is documented as unavailable
# on eleven_v3 ("Request stitching is not available for the eleven_v3 model").
MODEL_UNSUPPORTED = {
    "similarity_boost": {"eleven_v3": "not available on Eleven v3"},
    "use_speaker_boost": {"eleven_v3": "not available on Eleven v3"},
    "request_continuity": {"eleven_v3": "request stitching not available on Eleven v3"},
}

# name → spec. Order is the console's render order within each group.
#   kind:    "float" | "enum" | "bool"
#   lo/hi:   inclusive bounds (float knobs)
#   choices: allowed values (enum knobs)
#   step:    UI slider granularity (float knobs)
#   timing:  when a change lands — mirrors target, surfaced for the UI badge
#   hint:    one-line operator note (optional)
KNOBS = {
    # ── RVC (parked engine; mid-stream socket frame) ──────────────────
    "index_rate":      {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.75, "step": 0.05,
                        "target": "rvc", "engines": ("rvc",), "group": "RVC",
                        "timing": "mid-stream", "label": "Index Rate"},
    "protect":         {"kind": "float", "lo": 0.0, "hi": 0.5, "default": 0.33, "step": 0.01,
                        "target": "rvc", "engines": ("rvc",), "group": "RVC",
                        "timing": "mid-stream", "label": "Protect"},
    "rms_mix_rate":    {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.25, "step": 0.05,
                        "target": "rvc", "engines": ("rvc",), "group": "RVC",
                        "timing": "mid-stream", "label": "RMS Mix"},
    "f0_method":       {"kind": "enum", "choices": F0_METHODS, "default": "rmvpe",
                        "target": "rvc", "engines": ("rvc",), "group": "RVC",
                        "timing": "mid-stream", "label": "F0 Method"},

    # ── ElevenLabs voice (tts engine; applies to next utterance) ──────
    # `voice` choices are DYNAMIC — the account's voices (GET /v1/voices) are
    # injected at broadcast time; clamp accepts any voice_id string and the apply
    # path validates it against the live list. Default None ⇒ the agent supplies
    # the startup voice (ELEVENLABS_VOICE_ID). Excluded from defaults()/ranges().
    "voice":           {"kind": "enum", "choices": (), "default": None, "dynamic": True,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Voice",
                        "hint": "account voices (clones + premade); switching resets continuity and loads the voice's own settings"},
    "tts_model":       {"kind": "enum", "choices": TTS_MODELS, "default": DEFAULT_TTS_MODEL,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "TTS Model",
                        "hint": "flash v2.5 fastest · multilingual v2 quality ref · v3 most expressive"},
    "stability":       {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.5, "step": 0.05,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Stability",
                        "hint": "low = more emotional range · high = more monotone (v3: ~0 Creative / 0.5 Natural / 1 Robust)"},
    "similarity_boost": {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.75, "step": 0.05,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Similarity Boost",
                        "hint": "higher adheres to the clone · slight latency cost"},
    "style":           {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.0, "step": 0.05,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Style",
                        "hint": "0 = off · >0 exaggerates style but ADDS LATENCY and can reduce stability"},
    "use_speaker_boost": {"kind": "bool", "default": True,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Speaker Boost",
                        "hint": "clarity/similarity boost · slight latency cost"},
    "speed":           {"kind": "float", "lo": 0.25, "hi": 4.0, "default": 1.0, "step": 0.05,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Speed",
                        "hint": "1.0 = natural · usable range ~0.7–1.2 · REST allows 0.25–4.0"},
    "request_continuity": {"kind": "bool", "default": True,
                        "target": "tts", "engines": ("tts",), "group": "ElevenLabs voice",
                        "timing": "next utterance", "label": "Request Continuity",
                        "hint": "condition each utterance on the previous (request stitching) so delivery holds across a session · not on v3"},

    # ── Pipeline (in-process, instant) ────────────────────────────────
    "prime_hops":      {"kind": "float", "lo": 0.5, "hi": 4.0, "default": 1.5, "step": 0.1,
                        "target": "agent", "engines": ("rvc", "tts"), "group": "Pipeline",
                        "timing": "instant", "label": "Prime Depth (hops)",
                        "hint": "jitter-buffer priming depth · lower = less delay, less underrun margin"},
    "vad_threshold":   {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.5, "step": 0.05,
                        "target": "agent", "engines": ("rvc", "tts"), "group": "Pipeline",
                        "timing": "instant", "label": "VAD Threshold",
                        "hint": "speech probability needed to open the gate"},
    "vad_hangover_ms": {"kind": "float", "lo": 0.0, "hi": 2000.0, "default": 300.0, "step": 50.0,
                        "target": "agent", "engines": ("rvc", "tts"), "group": "Pipeline",
                        "timing": "instant", "label": "VAD Hangover (ms)",
                        "hint": "gate stays open this long after speech · in tts mode it sits directly in tail latency"},
    # tts-only pipeline knobs (endpointer + queue live only in tts mode)
    "min_speech_ms":   {"kind": "float", "lo": 0.0, "hi": 1000.0, "default": 200.0, "step": 50.0,
                        "target": "agent", "engines": ("tts",), "group": "Pipeline",
                        "timing": "instant", "label": "Min Speech (ms)",
                        "hint": "gate-open spans with less speech than this are dropped as blips — no STT call, no spend"},
    "queue_wait_warn_ms": {"kind": "float", "lo": 0.0, "hi": 5000.0, "default": 250.0, "step": 50.0,
                        "target": "agent", "engines": ("tts",), "group": "Pipeline",
                        "timing": "instant", "label": "Queue Warn (ms)",
                        "hint": "diagnostic only — logs when an utterance waited behind the pipeline; does not change audio"},
    "comfort_noise_db": {"kind": "float", "lo": -80.0, "hi": -40.0, "default": -60.0, "step": 1.0,
                        "target": "agent", "engines": ("tts",), "group": "Pipeline",
                        "timing": "instant", "label": "Comfort Noise (dBFS)",
                        "hint": "low-level room-tone bed under gate-closed silence so gaps don't feel dead · -80 = off, -40 = loudest"},

    # ── Loudness (tts; levels each utterance before enqueue) ──────────
    # Fixes the CEO's "volume sags across consecutive utterances": each
    # synthesized utterance is measured (RMS) and leveled to the target with a
    # soft limiter (never clips). See loudness.py for the RMS-vs-LUFS decision.
    "loudness_normalize": {"kind": "bool", "default": True,
                        "target": "agent", "engines": ("tts",), "group": "Loudness",
                        "timing": "next utterance", "label": "Loudness Normalize",
                        "hint": "level every utterance to the target so volume holds across a session · RMS + soft limiter, never clips · off = the raw synthesis"},
    "loudness_target_db": {"kind": "float", "lo": -40.0, "hi": -12.0, "default": -20.0, "step": 0.5,
                        "target": "agent", "engines": ("tts",), "group": "Loudness",
                        "timing": "next utterance", "label": "Loudness Target (dBFS)",
                        "hint": "RMS target · ~-20 dBFS is a natural speech level · higher = louder, the limiter guards the peaks"},

    # ── Spend (tts; governor caps, walled by env-only ceilings) ───────
    # The session caps became console knobs (ticket 2 — this REVERSES the #19
    # "no sliders" ruling), but each is DYNAMIC: its upper bound is the env-only
    # ceiling (SPIKE_MAX_*_CEILING), injected at broadcast time, and the apply
    # path clamps to it and reports the three-way disposition. Excluded from
    # defaults()/ranges(); the agent supplies the live value + ceiling. The
    # ceiling is the wall the client can never breach (see spend_governor.py).
    "tts_chars": {"kind": "float", "dynamic": True, "default": None, "step": 100.0,
                        "target": "governor", "engines": ("tts",), "group": "Spend",
                        "timing": "instant", "label": "TTS Char Cap",
                        "hint": "session synthesis budget · walled by SPIKE_MAX_TTS_CHARS_CEILING (env-only)"},
    "stt_seconds": {"kind": "float", "dynamic": True, "default": None, "step": 10.0,
                        "target": "governor", "engines": ("tts",), "group": "Spend",
                        "timing": "instant", "label": "STT Second Cap",
                        "hint": "session transcription budget · walled by SPIKE_MAX_STT_SECONDS_CEILING (env-only)"},
}

# Fallback slider bounds for the dynamic governor knobs when no live ceiling is
# supplied to metadata(). Resolved from a real SpendGovernor (lazily, cached)
# rather than mirrored literals: a mirrored number and the governor's ACTUAL
# env-resolved wall can disagree the moment an env override exists, and the
# metadata would then advertise a range the live governor refuses (CodeRabbit,
# PR 82). The broadcast always passes the real ceiling; this path only serves
# a metadata() call without one.
_CAP_CEILING_KEY = {"tts_chars": "tts_chars_ceiling", "stt_seconds": "stt_seconds_ceiling"}
_cap_ceiling_fallback_cache = None


def _cap_ceiling_fallback():
    global _cap_ceiling_fallback_cache
    if _cap_ceiling_fallback_cache is None:
        from spend_governor import SpendGovernor  # local: avoids import at module load

        g = SpendGovernor()
        _cap_ceiling_fallback_cache = {
            "tts_chars": float(g.tts_chars_ceiling),
            "stt_seconds": float(g.stt_seconds_ceiling),
        }
    return _cap_ceiling_fallback_cache


def _relevant(engine):
    """Knob names valid for `engine` (None ⇒ all knobs, insertion order)."""
    if engine is None:
        return list(KNOBS)
    return [name for name, spec in KNOBS.items() if engine in spec["engines"]]


def _cap_ceiling(name, spend):
    """Live env ceiling for a dynamic governor cap knob (its slider max = the
    wall). Read from the governor snapshot; falls back to the registry default
    when no snapshot is supplied (metadata() called without a live governor)."""
    if spend and _CAP_CEILING_KEY.get(name) in (spend or {}):
        return spend[_CAP_CEILING_KEY[name]]
    return _cap_ceiling_fallback().get(name)


def defaults(engine=None):
    """{name: default} for `engine` (None ⇒ every knob).

    Dynamic knobs (e.g. `voice`, whose choices/default are runtime-populated)
    are excluded — they have no meaningful static default; the agent supplies
    the live default in the broadcast."""
    return {name: KNOBS[name]["default"] for name in _relevant(engine)
            if not KNOBS[name].get("dynamic")}


def ranges(engine=None):
    """JSON-friendly range description for the UI (rendered from agent truth)."""
    out = {}
    for name in _relevant(engine):
        spec = KNOBS[name]
        if spec.get("dynamic"):
            continue                       # runtime-populated; see metadata()
        if spec["kind"] == "enum":
            out[name] = {"choices": list(spec["choices"])}
        elif spec["kind"] == "bool":
            out[name] = {"kind": "bool"}
        else:
            out[name] = {"lo": spec["lo"], "hi": spec["hi"]}
    return out


def metadata(engine=None, voice_choices=None, spend=None):
    """Full per-knob display metadata as an ORDERED list so the console can
    render knob groups with zero hardcoded engine assumptions. Includes the
    per-model support map (`unsupported_models`) so the UI disables a knob the
    current model ignores and shows why.

    `voice_choices` (list of {"id","name","category"?}) is injected into the
    dynamic `voice` knob as its choices + `choice_labels` (display names).
    `spend` (the governor snapshot) supplies the live upper bound (env ceiling)
    for the dynamic governor cap knobs — the wall the slider maxes out at."""
    voice_choices = voice_choices or []
    out = []
    for name in _relevant(engine):
        spec = KNOBS[name]
        entry = {
            "name": name,
            "kind": spec["kind"],
            "label": spec["label"],
            "group": spec["group"],
            "target": spec["target"],
            "engines": list(spec["engines"]),
            "timing": spec["timing"],
            "default": spec["default"],
        }
        if spec["kind"] == "enum":
            if spec.get("dynamic") and name == "voice":
                entry["choices"] = [v["id"] for v in voice_choices]
                entry["choice_labels"] = {
                    v["id"]: (f"{v['name']} ({v['category']})" if v.get("category")
                              else v.get("name") or v["id"])
                    for v in voice_choices
                }
                # The category EXPLICITLY, id → category, so the console can
                # group the selector ("your voices" vs "system voices")
                # without parsing it back out of the display label.
                entry["choice_categories"] = {
                    v["id"]: v["category"] for v in voice_choices if v.get("category")
                }
                entry["dynamic"] = True
            else:
                entry["choices"] = list(spec["choices"])
        elif spec["kind"] == "float":
            if spec.get("dynamic"):
                # governor caps: lo=0, hi=the live env ceiling (the wall)
                entry["lo"] = 0.0
                entry["hi"] = _cap_ceiling(name, spend)
                entry["step"] = spec["step"]
                entry["dynamic"] = True
            else:
                entry["lo"] = spec["lo"]
                entry["hi"] = spec["hi"]
                entry["step"] = spec["step"]
        if "hint" in spec:
            entry["hint"] = spec["hint"]
        if name in MODEL_UNSUPPORTED:
            entry["unsupported_models"] = dict(MODEL_UNSUPPORTED[name])
        out.append(entry)
    return out


def model_unsupported(knob_name, model_id):
    """Reason string if `knob_name` is unsupported on `model_id`, else None.

    Pure predicate for the per-model validation the apply path runs once it
    knows the live/target model (clamp_params stays model-agnostic)."""
    return MODEL_UNSUPPORTED.get(knob_name, {}).get(model_id)


def model_supports_stitching(model_id):
    """True if `model_id` supports request stitching (previous_request_ids).

    False for eleven_v3 — the engine skips continuity conditioning on it rather
    than sending a field the model rejects."""
    return model_unsupported("request_continuity", model_id) is None


def clamp_params(params):
    """Sanitize a raw knob-update payload (range/type only — not per-model).

    Returns (applied, adjusted, rejected):
      applied   {name: in-range value} — safe to use as-is
      adjusted  {name: {"requested": raw, "applied": value}} — out-of-range
                values that were clamped into range
      rejected  {name: reason} — unknown knobs, wrong types, invalid enum/bool
                values; the current setting stays untouched

    Never raises: any garbage lands in `rejected`.
    """
    applied, adjusted, rejected = {}, {}, {}
    if not isinstance(params, dict):
        return {}, {}, {"*": "params must be an object"}
    for name, raw in params.items():
        spec = KNOBS.get(name)
        if spec is None:
            rejected[name] = "unknown knob"
            continue
        if spec["kind"] == "enum":
            if spec.get("dynamic"):
                # Runtime-populated choices (e.g. account voices). Accept any
                # non-empty string, case-preserved (voice_ids are case-
                # sensitive); the apply path validates it against the live list.
                if isinstance(raw, str) and raw.strip():
                    applied[name] = raw
                else:
                    rejected[name] = "must be a non-empty string"
                continue
            if isinstance(raw, str) and raw.lower() in spec["choices"]:
                applied[name] = raw.lower()
            else:
                rejected[name] = f"must be one of {list(spec['choices'])}"
            continue
        if spec["kind"] == "bool":
            # Strict: a real JSON boolean only. 0/1/"true" would each be a
            # different caller guessing at the wire format — reject and let the
            # frontend (which sends real booleans) be the contract.
            if isinstance(raw, bool):
                applied[name] = raw
            else:
                rejected[name] = "must be a boolean"
            continue
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            rejected[name] = "must be a number"
            continue
        value = float(raw)
        if value != value or value in (float("inf"), float("-inf")):
            rejected[name] = "must be finite"
            continue
        if spec.get("dynamic"):
            # Runtime-bounded (governor caps: the upper bound is an env ceiling
            # this pure function can't see). Accept any finite value >= 0; the
            # apply path clamps it to the live ceiling and reports the
            # disposition (adjusted when it hits the wall).
            if value < 0:
                rejected[name] = "must be >= 0"
            else:
                applied[name] = value
            continue
        clamped = min(spec["hi"], max(spec["lo"], value))
        applied[name] = clamped
        if clamped != value:
            adjusted[name] = {"requested": value, "applied": clamped}
    return applied, adjusted, rejected


# ── Config-as-code: profile precedence ───────────────────────────────
#
# Startup config resolves highest-wins: CLI/env overrides > committed profile >
# defaults. "Locking in" the CEO's ear-found profile = committing one JSON via
# PR (reviewable, no code edit). The resolver is a clean 3-layer overlay so the
# precedence is unit-testable; the agent supplies the `defaults` layer already
# refined by the clone's own fetched voice settings (see convert_agent).

PROFILE_VOICE_KEYS = ("stability", "similarity_boost", "style",
                      "use_speaker_boost", "speed")
PROFILE_PIPELINE_KEYS = ("vad_threshold", "vad_hangover_ms", "prime_hops",
                         "min_speech_ms", "queue_wait_warn_ms")


def flatten_profile(profile):
    """A committed/exported profile dict → flat {knob: value}.

    Reads the nested export shape ({engine, model, voice_settings{}, pipeline{}})
    AND any already-flat top-level knob keys. `model` maps to the `tts_model`
    knob. Unknown keys are left for clamp_params to reject. Pure; never raises on
    a well-formed dict."""
    flat = {}
    if not isinstance(profile, dict):
        return flat
    if isinstance(profile.get("voice_settings"), dict):
        flat.update(profile["voice_settings"])
    if isinstance(profile.get("pipeline"), dict):
        flat.update(profile["pipeline"])
    if profile.get("model") is not None:
        flat["tts_model"] = profile["model"]
    # allow flat top-level knob keys too (round-trips a flattened profile)
    for name in KNOBS:
        if name in profile:
            flat[name] = profile[name]
    return flat


def resolve_precedence(base, profile, cli):
    """3-layer highest-wins overlay: cli > profile > base. Inputs are flat
    {knob: value} dicts; `cli` holds only keys the operator explicitly set.
    Pure."""
    resolved = dict(base or {})
    resolved.update(profile or {})
    resolved.update(cli or {})
    return resolved


def prime_hops_to_samples(hops):
    return int(hops * HOP)
