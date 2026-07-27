"""Phase 4 tuning-knob registry — pure logic, no I/O.

Single source of truth for every live-tunable parameter: type, range,
default, and where it applies ("rvc" = sent as a mid-stream JSON settings
frame on the open RVC websocket; "agent" = applied in-process instantly).

Server-side facts verified against OpenVoiceChanger backend @ 4cee7ef
(backend/routers/websocket.py + services/rvc_processor.py):
  - JSON text frames are accepted at ANY time on the open socket and merged
    into connection state; each audio frame re-reads them → mid-stream
    updates work, no reconnect needed
  - f0 methods actually supported: rmvpe / harvest / crepe / pm (dio is
    aliased to pm; fcpe only when torchfcpe is present — both excluded)

clamp_params() is the fail-safety chokepoint: whatever arrives over the data
channel comes out as in-range applied values + a report of what was adjusted
or rejected. It never raises on malformed input.
"""

from bridge import HOP

F0_METHODS = ("rmvpe", "harvest", "crepe", "pm")

# name → spec. lo/hi are inclusive. "agent" knobs apply instantly in-process;
# "rvc" knobs go out as one JSON settings frame on the open websocket.
KNOBS = {
    "index_rate":      {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.75, "target": "rvc"},
    "protect":         {"kind": "float", "lo": 0.0, "hi": 0.5, "default": 0.33, "target": "rvc"},
    "rms_mix_rate":    {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.25, "target": "rvc"},
    "f0_method":       {"kind": "enum", "choices": F0_METHODS, "default": "rmvpe", "target": "rvc"},
    "prime_hops":      {"kind": "float", "lo": 0.5, "hi": 4.0, "default": 1.5, "target": "agent"},
    "vad_threshold":   {"kind": "float", "lo": 0.0, "hi": 1.0, "default": 0.5, "target": "agent"},
    "vad_hangover_ms": {"kind": "float", "lo": 0.0, "hi": 2000.0, "default": 300.0, "target": "agent"},
}


def defaults():
    return {name: spec["default"] for name, spec in KNOBS.items()}


def ranges():
    """JSON-friendly range description for the UI (rendered from agent truth)."""
    out = {}
    for name, spec in KNOBS.items():
        if spec["kind"] == "enum":
            out[name] = {"choices": list(spec["choices"])}
        else:
            out[name] = {"lo": spec["lo"], "hi": spec["hi"]}
    return out


def clamp_params(params):
    """Sanitize a raw knob-update payload.

    Returns (applied, adjusted, rejected):
      applied   {name: in-range value} — safe to use as-is
      adjusted  {name: {"requested": raw, "applied": value}} — out-of-range
                values that were clamped into range
      rejected  {name: reason} — unknown knobs, wrong types, invalid enum
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
            if isinstance(raw, str) and raw.lower() in spec["choices"]:
                applied[name] = raw.lower()
            else:
                rejected[name] = f"must be one of {list(spec['choices'])}"
            continue
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            rejected[name] = "must be a number"
            continue
        value = float(raw)
        if value != value or value in (float("inf"), float("-inf")):
            rejected[name] = "must be finite"
            continue
        clamped = min(spec["hi"], max(spec["lo"], value))
        applied[name] = clamped
        if clamped != value:
            adjusted[name] = {"requested": value, "applied": clamped}
    return applied, adjusted, rejected


def prime_hops_to_samples(hops):
    return int(hops * HOP)
