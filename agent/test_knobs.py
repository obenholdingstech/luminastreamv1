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
    assert set(applied) == set(knobs.KNOBS)
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
