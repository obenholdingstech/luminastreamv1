"""One agent adopts one speaker — and says so when it refuses a second.

The refusal itself is old behaviour (`_maybe_adopt` has always ignored a
second track). What was missing is that the ignored participant had no way to
know: their mic reaches the room, nothing comes back, and the failure is
indistinguishable from a dead pipeline. These tests pin the broadcast that
makes it legible, and pin that the adoption rules themselves did not change.
"""
import asyncio
import json
import types

import pytest


def _agent(**kw):
    from convert_agent import ConvertAgent
    return ConvertAgent("room", "echo-test", "ws://127.0.0.1:9", "convert",
                        vad=None, **kw)


def _participant(identity):
    return types.SimpleNamespace(identity=identity)


def _audio_track():
    from livekit import rtc
    return types.SimpleNamespace(kind=rtc.TrackKind.KIND_AUDIO)


class _CapturingRoom:
    """Stands in for rtc.Room, recording what the agent publishes."""

    def __init__(self, connected=True):
        from livekit import rtc
        self.connection_state = (rtc.ConnectionState.CONN_CONNECTED if connected
                                 else rtc.ConnectionState.CONN_DISCONNECTED)
        self.published = []
        room = self

        class _LP:
            async def publish_data(self, payload, reliable=True):
                room.published.append(json.loads(payload))

        self.local_participant = _LP()


def test_second_speaker_is_ignored_and_announced():
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()
        # First speaker adopted: a live process_task is what marks the agent busy.
        agent.processed_identity = "studio-aaa"
        agent.process_task = asyncio.ensure_future(asyncio.sleep(3600))

        agent._maybe_adopt(_audio_track(), _participant("studio-bbb"))
        await asyncio.sleep(0)  # let the spawned publish run
        await asyncio.sleep(0)

        busy = [m for m in agent.room.published if m["type"] == "agent_busy"]
        assert len(busy) == 1, agent.room.published
        assert busy[0]["processing"] == "studio-aaa"
        assert busy[0]["ignored"] == "studio-bbb"
        assert busy[0]["reason"] == "one_speaker_per_agent"

        # The refusal still holds: the incumbent keeps the slot.
        assert agent.processed_identity == "studio-aaa"

        agent.process_task.cancel()

    asyncio.run(run())


def test_holder_is_snapshotted_before_the_task_runs():
    """The incumbent's name must survive cleanup racing the background task.

    _publish_busy is spawned, not awaited. If it read self.processed_identity
    when finally polled, a _process cleanup landing first would broadcast
    "processing": null — naming nobody, in the one message whose entire job
    is to name somebody.
    """
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()
        agent.processed_identity = "studio-aaa"
        agent.process_task = asyncio.ensure_future(asyncio.sleep(3600))

        agent._maybe_adopt(_audio_track(), _participant("studio-bbb"))
        # Cleanup wins the race: state is cleared before the task is polled.
        agent.processed_identity = None
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        busy = [m for m in agent.room.published if m["type"] == "agent_busy"]
        assert len(busy) == 1, agent.room.published
        assert busy[0]["processing"] == "studio-aaa", (
            "broadcast lost the incumbent to a cleanup race")

        agent.process_task.cancel()

    asyncio.run(run())


def test_capture_event_is_written_at_the_rejection_point():
    """Recorded synchronously, so it lands on the session that rejected."""
    async def run():
        events = []

        class _Cap:
            def event(self, name, **kw):
                events.append((name, kw))

        agent = _agent()
        agent.room = _CapturingRoom()
        agent.capture = _Cap()
        agent.processed_identity = "studio-aaa"
        agent.process_task = asyncio.ensure_future(asyncio.sleep(3600))

        agent._maybe_adopt(_audio_track(), _participant("studio-bbb"))
        # Written before any await — present immediately, not after a tick.
        assert events == [("agent_busy", {
            "processing": "studio-aaa",
            "ignored": "studio-bbb",
            "reason": "one_speaker_per_agent",
        })], events

        agent.process_task.cancel()

    asyncio.run(run())


def test_first_speaker_is_adopted_silently():
    """No busy broadcast when there is nothing to refuse."""
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()
        adopted = []

        async def _fake_process(track, identity):
            adopted.append(identity)
            await asyncio.sleep(3600)

        agent._process = _fake_process
        agent._maybe_adopt(_audio_track(), _participant("studio-aaa"))
        await asyncio.sleep(0)

        assert adopted == ["studio-aaa"]
        assert [m for m in agent.room.published if m["type"] == "agent_busy"] == []
        agent.process_task.cancel()

    asyncio.run(run())


def test_fellow_agents_never_trigger_a_busy_broadcast():
    """echo-* participants are peers, not speakers — refusing them is not news."""
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()
        agent.processed_identity = "studio-aaa"
        agent.process_task = asyncio.ensure_future(asyncio.sleep(3600))

        agent._maybe_adopt(_audio_track(), _participant("echo-smoke"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert agent.room.published == []
        agent.process_task.cancel()

    asyncio.run(run())


def test_busy_broadcast_is_a_no_op_while_disconnected():
    """Publishing into a disconnected room must not raise into the audio path."""
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom(connected=False)
        agent.processed_identity = "studio-aaa"

        await agent._publish_busy("studio-bbb", "studio-aaa")
        assert agent.room.published == []

    asyncio.run(run())


def test_publish_failure_is_swallowed_not_raised():
    """A data-channel failure is a diagnostics problem, never a pipeline one."""
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()

        async def _boom(payload, reliable=True):
            raise RuntimeError("data channel down")

        agent.room.local_participant.publish_data = _boom
        agent.processed_identity = "studio-aaa"

        await agent._publish_busy("studio-bbb", "studio-aaa")  # must not raise

    asyncio.run(run())


def test_finished_process_task_frees_the_slot():
    """When the first speaker leaves, the next one is adopted, not refused."""
    async def run():
        agent = _agent()
        agent.room = _CapturingRoom()
        agent.processed_identity = "studio-aaa"
        done = asyncio.ensure_future(asyncio.sleep(0))
        await done
        agent.process_task = done

        adopted = []

        async def _fake_process(track, identity):
            adopted.append(identity)
            await asyncio.sleep(3600)

        agent._process = _fake_process
        agent._maybe_adopt(_audio_track(), _participant("studio-bbb"))
        await asyncio.sleep(0)

        assert adopted == ["studio-bbb"]
        assert [m for m in agent.room.published if m["type"] == "agent_busy"] == []
        agent.process_task.cancel()

    asyncio.run(run())


def test_non_audio_tracks_are_ignored_without_noise():
    async def run():
        from livekit import rtc
        agent = _agent()
        agent.room = _CapturingRoom()
        agent.processed_identity = "studio-aaa"
        agent.process_task = asyncio.ensure_future(asyncio.sleep(3600))

        video = types.SimpleNamespace(kind=rtc.TrackKind.KIND_VIDEO)
        agent._maybe_adopt(video, _participant("studio-bbb"))
        await asyncio.sleep(0)

        assert agent.room.published == []
        agent.process_task.cancel()

    asyncio.run(run())
