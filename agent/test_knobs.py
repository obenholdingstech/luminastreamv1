"""Phase 4 tuning-knob tests: clamping fail-safety, capture snapshots, and the
mid-stream RVC settings path (against an in-process mock server speaking the
verified OpenVoiceChanger protocol)."""

import asyncio
import json

import websockets

import knobs
from capture import SessionCapture
from rvc_client import RvcClient


# ── clamp_params: the fail-safety chokepoint ─────────────────────────


def test_in_range_values_pass_through():
    applied, adjusted, rejected = knobs.clamp_params(
        {"index_rate": 0.5, "protect": 0.2, "f0_method": "harvest"})
    assert applied == {"index_rate": 0.5, "protect": 0.2, "f0_method": "harvest"}
    assert adjusted == {} and rejected == {}


def test_out_of_range_clamped_and_reported():
    applied, adjusted, rejected = knobs.clamp_params(
        {"index_rate": 1.7, "protect": -3, "vad_hangover_ms": 99999})
    assert applied == {"index_rate": 1.0, "protect": 0.0, "vad_hangover_ms": 2000.0}
    assert set(adjusted) == {"index_rate", "protect", "vad_hangover_ms"}
    assert adjusted["index_rate"] == {"requested": 1.7, "applied": 1.0}
    assert rejected == {}


def test_garbage_rejected_never_raises():
    applied, adjusted, rejected = knobs.clamp_params({
        "index_rate": "loud",          # wrong type
        "protect": True,               # bool is not a number here
        "f0_method": "dio",            # server aliases it away — not offered
        "rms_mix_rate": float("nan"),  # non-finite
        "warp_factor": 11,             # unknown knob
    })
    assert applied == {}
    assert set(rejected) == {"index_rate", "protect", "f0_method",
                             "rms_mix_rate", "warp_factor"}


def test_non_dict_payload_rejected():
    for garbage in (None, 7, "x", [1, 2]):
        applied, _adj, rejected = knobs.clamp_params(garbage)
        assert applied == {} and rejected


def test_enum_case_insensitive():
    applied, _adj, rejected = knobs.clamp_params({"f0_method": "RMVPE"})
    assert applied == {"f0_method": "rmvpe"} and rejected == {}


def test_registry_defaults_are_in_range():
    applied, adjusted, rejected = knobs.clamp_params(knobs.defaults())
    # dynamic knobs (voice) are runtime-populated and excluded from defaults()
    assert set(applied) == {n for n, s in knobs.KNOBS.items() if not s.get("dynamic")}
    assert adjusted == {} and rejected == {}


# ── capture: config_change carries the full snapshot ─────────────────


def test_config_change_event_snapshot(tmp_path):
    async def run():
        cap = SessionCapture(tmp_path, {"mode": "convert"}).start()
        cap.event("config_change", requested={"protect": 0.9},
                  config={"protect": 0.5, "index_rate": 0.75, "f0_method": "rmvpe"},
                  adjusted={"protect": {"requested": 0.9, "applied": 0.5}},
                  rejected=None)
        await cap.aclose()
        return cap.session_dir

    session_dir = asyncio.run(run())
    events = [json.loads(line) for line in
              (session_dir / "meta.jsonl").read_text().splitlines()]
    ev = next(e for e in events if e["event"] == "config_change")
    assert ev["config"]["protect"] == 0.5          # full applied snapshot
    assert ev["config"]["f0_method"] == "rmvpe"    # …not just the changed knob
    assert ev["adjusted"]["protect"]["applied"] == 0.5
    assert "t" in ev and "in_pos" in ev            # timeline-attributable


# ── mid-stream RVC settings: the path verified against the server ────


class SettingsRecorder:
    """Minimal WS server speaking the OpenVoiceChanger protocol shape:
    JSON config first, then binary frames echoed, text frames recorded."""

    def __init__(self):
        self.texts = []

    async def handle(self, ws):
        async for msg in ws:
            if isinstance(msg, str):
                self.texts.append(json.loads(msg))
            else:
                await ws.send(msg)  # echo warmup/audio frames unchanged


def run_with_server(scenario):
    """Start a SettingsRecorder server on an ephemeral port and run
    scenario(recorder, url) inside the same event loop."""
    recorder = SettingsRecorder()

    async def main():
        server = await websockets.serve(recorder.handle, "127.0.0.1", 0, max_size=None)
        port = server.sockets[0].getsockname()[1]
        try:
            await scenario(recorder, f"ws://127.0.0.1:{port}")
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(main())
    return recorder


def test_send_settings_live_frame_and_reconnect_carryover():
    async def scenario(recorder, url):
        client = RvcClient(url, config={"chunk_size": 64})
        await client.connect()
        live = await client.send_settings({"protect": 0.1, "f0_method": "harvest"})
        assert live is True
        await asyncio.sleep(0.05)  # let the frame land
        # reconnect: the merged config must carry the update (initial JSON)
        await client.connect()
        await client.close()

    recorder = run_with_server(scenario)
    initial, update, reconnect_initial = recorder.texts[0], recorder.texts[1], recorder.texts[2]
    assert "sample_rate" in initial                      # session config
    assert update == {"protect": 0.1, "f0_method": "harvest"}  # mid-stream frame
    assert reconnect_initial["protect"] == 0.1           # carried into reconnect
    assert reconnect_initial["f0_method"] == "harvest"


def test_agent_apply_config_end_to_end():
    """ConvertAgent._apply_config: clamp → apply to outgate/vad/rvc.config →
    snapshot reflects APPLIED values. No room connection needed (_publish_config
    no-ops while disconnected; rvc stores the update for its next connect)."""
    from bridge import HOP
    from convert_agent import ConvertAgent
    from vad import VadGate

    async def run():
        vad = VadGate(prob_fn=lambda c: 0.0)
        agent = ConvertAgent("room", "echo-test", "ws://127.0.0.1:9", "convert", vad=vad)
        await agent._apply_config({
            "protect": 0.9,          # above hi → clamps to 0.5
            "prime_hops": 2.0,       # agent-side, instant
            "vad_threshold": 0.8,    # agent-side, instant
            "f0_method": "harvest",  # rvc-side, stored (not connected)
            "nonsense": 1,           # rejected
        }, "test")
        snap = agent.config_snapshot()
        assert snap["protect"] == 0.5
        assert snap["prime_hops"] == 2.0
        assert agent.outgate.prime_samples == 2 * HOP
        assert vad.threshold == 0.8
        assert snap["f0_method"] == "harvest"
        assert agent.rvc.config["f0_method"] == "harvest"  # rides the next connect
        # snapshot renders APPLIED truth, not the 0.9 request
        assert snap["vad_threshold"] == 0.8

    asyncio.run(run())


def test_overlapping_applies_serialize_fifo():
    """CTO merge condition on PR #12: two overlapping _apply_config tasks must
    be strictly FIFO. With the first apply's RVC settings frame made slow, the
    server, rvc.config, and the final broadcast must all end on the LAST
    requested value — without _config_lock the frames interleave and the
    server finishes on the older one while the broadcast claims the newer."""
    from convert_agent import ConvertAgent

    async def scenario(recorder, url):
        agent = ConvertAgent("room", "echo-test", url, "convert", vad=None)
        await agent.rvc.connect()

        real_send = agent.rvc.send_settings
        delays = iter([0.05, 0.0])  # first apply slow, second instant

        async def slow_send(partial):
            await asyncio.sleep(next(delays, 0.0))
            return await real_send(partial)

        agent.rvc.send_settings = slow_send

        broadcasts = []

        async def record_publish(adjusted=None, rejected=None):
            broadcasts.append(agent.config_snapshot())

        agent._publish_config = record_publish

        first = agent._spawn(agent._apply_config({"protect": 0.1}, "test-a"))
        second = agent._spawn(agent._apply_config({"protect": 0.4}, "test-b"))
        await asyncio.gather(first, second)
        await asyncio.sleep(0.05)  # let the frames land at the recorder
        await agent.rvc.close()

        assert agent.rvc.config["protect"] == 0.4
        assert [b["protect"] for b in broadcasts] == [0.1, 0.4]

    recorder = run_with_server(scenario)
    # last settings frame the server saw carries the LAST requested value
    assert recorder.texts[-1] == {"protect": 0.4}


def test_send_settings_while_disconnected_stores_only():
    async def scenario(recorder, url):
        client = RvcClient(url, config={"chunk_size": 64})
        live = await client.send_settings({"index_rate": 0.9})  # not connected yet
        assert live is False
        await client.connect()  # initial config must include the stored value
        await client.close()

    recorder = run_with_server(scenario)
    assert recorder.texts[0]["index_rate"] == 0.9


# ── tts registry: bool/enum kinds, ranges, per-model support ─────────


def test_tts_bool_and_enum_and_range_clamping():
    applied, adjusted, rejected = knobs.clamp_params({
        "use_speaker_boost": False,      # bool kind
        "tts_model": "eleven_v3",        # enum kind
        "stability": 0.3,                # float in range
        "speed": 9.0,                    # float above hi (4.0) → clamped
        "style": -1,                     # float below lo (0.0) → clamped
    })
    assert applied["use_speaker_boost"] is False
    assert applied["tts_model"] == "eleven_v3"
    assert applied["stability"] == 0.3
    assert applied["speed"] == 4.0 and adjusted["speed"]["requested"] == 9.0
    assert applied["style"] == 0.0
    assert rejected == {}


def test_tts_bool_and_enum_reject_bad_types():
    applied, _adj, rejected = knobs.clamp_params({
        "use_speaker_boost": 1,          # int is NOT a bool here
        "tts_model": "eleven_v9",        # unknown model
        "speed": "fast",                 # wrong type
    })
    assert applied == {}
    assert set(rejected) == {"use_speaker_boost", "tts_model", "speed"}


def test_model_unsupported_matrix():
    # documented v3 negatives
    assert knobs.model_unsupported("similarity_boost", "eleven_v3")
    assert knobs.model_unsupported("use_speaker_boost", "eleven_v3")
    # supported everywhere else
    assert knobs.model_unsupported("similarity_boost", "eleven_flash_v2_5") is None
    assert knobs.model_unsupported("use_speaker_boost", "eleven_multilingual_v2") is None
    # settings with no per-model restriction, and non-voice knobs
    assert knobs.model_unsupported("stability", "eleven_v3") is None
    assert knobs.model_unsupported("speed", "eleven_v3") is None
    assert knobs.model_unsupported("style", "eleven_v3") is None
    assert knobs.model_unsupported("vad_threshold", "eleven_v3") is None


def test_defaults_and_ranges_are_engine_filtered():
    tts = knobs.defaults("tts")
    rvc = knobs.defaults("rvc")
    # engine-specific knobs appear only for their engine
    assert "stability" in tts and "tts_model" in tts and "index_rate" not in tts
    assert "index_rate" in rvc and "f0_method" in rvc and "stability" not in rvc
    # shared pipeline knobs appear for both
    for shared in ("prime_hops", "vad_threshold", "vad_hangover_ms"):
        assert shared in tts and shared in rvc
    # tts-only pipeline knobs only for tts
    assert "min_speech_ms" in tts and "min_speech_ms" not in rvc
    # ranges track the same filtering, and every default is in range
    assert set(knobs.ranges("tts")) == set(tts)
    a, adj, rej = knobs.clamp_params(tts)
    assert set(a) == set(tts) and adj == {} and rej == {}


def test_metadata_is_ordered_and_carries_ui_facts():
    md = knobs.metadata("tts")
    names = [e["name"] for e in md]
    assert names == knobs._relevant("tts")          # ordered, engine-filtered
    by_name = {e["name"]: e for e in md}
    # a float knob carries lo/hi/step; an enum carries choices; a bool its kind
    assert by_name["stability"]["kind"] == "float"
    assert {"lo", "hi", "step"} <= set(by_name["stability"])
    assert by_name["tts_model"]["choices"] == list(knobs.TTS_MODELS)
    assert by_name["use_speaker_boost"]["kind"] == "bool"
    # per-model support surfaced so the UI can disable-with-reason
    assert "eleven_v3" in by_name["similarity_boost"]["unsupported_models"]
    assert "unsupported_models" not in by_name["stability"]
    # every entry declares where it applies and when
    for e in md:
        assert e["group"] and e["timing"] and e["engines"]


# ── config-as-code: profile flattening + precedence ─────────────────


def test_flatten_profile_reads_nested_export_shape():
    flat = knobs.flatten_profile({
        "engine": "tts",
        "model": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.4, "style": 0.2},
        "pipeline": {"vad_hangover_ms": 200, "min_speech_ms": 150},
        "_comment": "ignored",
    })
    assert flat == {
        "tts_model": "eleven_multilingual_v2",
        "stability": 0.4, "style": 0.2,
        "vad_hangover_ms": 200, "min_speech_ms": 150,
    }


def test_flatten_profile_tolerates_garbage():
    assert knobs.flatten_profile(None) == {}
    assert knobs.flatten_profile({"voice_settings": "nope"}) == {}


def test_resolve_precedence_cli_over_profile_over_base():
    base = knobs.defaults("tts")
    profile = {"tts_model": "eleven_multilingual_v2", "stability": 0.4,
               "vad_hangover_ms": 200}
    cli = {"tts_model": "eleven_v3"}          # CLI wins over the profile
    resolved = knobs.resolve_precedence(base, profile, cli)
    assert resolved["tts_model"] == "eleven_v3"          # cli beat profile
    assert resolved["stability"] == 0.4                  # profile beat default
    assert resolved["vad_hangover_ms"] == 200            # profile beat default (300)
    assert resolved["speed"] == base["speed"]            # untouched default stands


# ── voice selector (dynamic enum) + continuity + comfort knobs ───────


def test_dynamic_voice_knob_clamp_and_metadata():
    # dynamic enum: clamp accepts an arbitrary, case-PRESERVED voice_id string
    a, _adj, rej = knobs.clamp_params({"voice": "T7QGPtToiqH4S8VlIkMJ"})
    assert a == {"voice": "T7QGPtToiqH4S8VlIkMJ"} and rej == {}
    assert "voice" in knobs.clamp_params({"voice": "   "})[2]     # blank rejected
    assert "voice" in knobs.clamp_params({"voice": 123})[2]       # non-string rejected
    # runtime-populated ⇒ excluded from the static defaults()/ranges()
    assert "voice" not in knobs.defaults("tts")
    assert "voice" not in knobs.ranges("tts")
    # metadata injects the account voices as choices + display labels
    voices = [{"id": "v1", "name": "Amy", "category": "cloned"},
              {"id": "v2", "name": "Rachel", "category": "premade"}]
    md = {e["name"]: e for e in knobs.metadata("tts", voice_choices=voices)}
    assert md["voice"]["choices"] == ["v1", "v2"]
    assert md["voice"]["choice_labels"]["v1"] == "Amy (cloned)"
    assert md["voice"]["dynamic"] is True
    assert md["voice"]["group"] == "ElevenLabs voice"
    # no voice_choices ⇒ still renders (empty choices), never crashes
    md2 = {e["name"]: e for e in knobs.metadata("tts")}
    assert md2["voice"]["choices"] == []


def test_model_supports_stitching():
    assert knobs.model_supports_stitching("eleven_flash_v2_5") is True
    assert knobs.model_supports_stitching("eleven_multilingual_v2") is True
    assert knobs.model_supports_stitching("eleven_v3") is False
    # request_continuity carries the v3 disable reason (UI + apply path)
    assert knobs.model_unsupported("request_continuity", "eleven_v3")
    md = {e["name"]: e for e in knobs.metadata("tts")}
    assert "eleven_v3" in md["request_continuity"]["unsupported_models"]


def test_continuity_and_comfort_knobs_clamp():
    a, _adj, rej = knobs.clamp_params({
        "request_continuity": False,       # new bool kind
        "comfort_noise_db": -55.0,         # float in range
    })
    assert a["request_continuity"] is False
    assert a["comfort_noise_db"] == -55.0 and rej == {}
    # comfort clamps within [-80, -40]
    assert knobs.clamp_params({"comfort_noise_db": -100})[0]["comfort_noise_db"] == -80.0
    assert knobs.clamp_params({"comfort_noise_db": 0})[0]["comfort_noise_db"] == -40.0
    # request_continuity is a bool: a number is rejected, not coerced
    assert "request_continuity" in knobs.clamp_params({"request_continuity": 1})[2]
