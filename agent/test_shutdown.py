"""Shutdown is a signal contract, and systemd is the party on the other end.

`lumina-agent.service` sends SIGTERM and waits `TimeoutStopSec=30` for a clean
exit. If the agent ignores the signal, systemd escalates to SIGKILL and the
capture WAV headers are never finalised — the evidence of whatever session was
running is corrupted. If it exits nonzero on an ordinary stop, `Restart=always`
still restarts it but the unit's failure counters move for no reason, and
`StartLimitBurst=5` exists precisely so that real failures park the unit rather
than bill ElevenLabs all night. A stop that lies about its exit status spends
that budget on nothing.

These run the REAL `wait_for_stop` in a subprocess and signal it, rather than
asserting from the shape of the source. The handler installation is exactly the
thing that cannot be verified by reading: `loop.add_signal_handler` fails on
some platforms and the code deliberately falls through to default handling.
"""

import os
import signal
import subprocess
import sys
import textwrap
import time

import pytest

AGENT_DIR = os.path.dirname(os.path.abspath(__file__))

# A minimal host for the real function. Nothing here needs LiveKit, secrets, or
# a network — wait_for_stop is deliberately free of all of it.
HARNESS = textwrap.dedent(
    """
    import asyncio, sys
    sys.path.insert(0, {agent_dir!r})
    from convert_agent import wait_for_stop

    async def main():
        print("READY", flush=True)
        await wait_for_stop()
        print("CLEAN", flush=True)

    asyncio.run(main())
    """
)


def _spawn():
    proc = subprocess.Popen(
        [sys.executable, "-c", HARNESS.format(agent_dir=AGENT_DIR)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        # Its own process group, so a signal aimed at the child cannot travel
        # up to pytest itself and take the whole run down with it.
        start_new_session=True,
    )
    # Wait for the handlers to actually be installed. Signalling before that is
    # a race that would test the interpreter's default handling instead of ours.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if line.strip() == "READY":
            return proc
        if proc.poll() is not None:
            raise AssertionError(f"harness died early: {proc.stderr.read()}")
    proc.kill()
    raise AssertionError("harness never became READY")


@pytest.mark.parametrize("signame", ["SIGINT", "SIGTERM"])
def test_stops_cleanly_and_exits_zero(signame):
    """Both signals shut down cleanly, and the exit status says 'fine'."""
    proc = _spawn()
    proc.send_signal(getattr(signal, signame))
    try:
        out, err = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        pytest.fail(f"{signame} did not stop the agent within 15s")

    assert "CLEAN" in out, f"{signame} did not reach the clean shutdown path\n{err}"
    assert proc.returncode == 0, (
        f"{signame} exited {proc.returncode}, not 0. systemd counts a nonzero "
        f"stop toward StartLimitBurst, which is a spend control.\n{err}"
    )
    # A stop is a normal event. A traceback in the journal on every restart
    # trains whoever reads it to ignore tracebacks.
    assert "Traceback" not in err, f"{signame} printed a traceback:\n{err}"


def test_run_seconds_ends_the_run_without_any_signal():
    """Scripted drills take signals out of the picture entirely."""
    harness = textwrap.dedent(
        f"""
        import asyncio, sys
        sys.path.insert(0, {AGENT_DIR!r})
        from convert_agent import wait_for_stop

        async def main():
            await wait_for_stop(run_seconds=0.4)
            print("ELAPSED", flush=True)

        asyncio.run(main())
        """
    )
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-c", harness],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert proc.returncode == 0, proc.stderr
    assert "ELAPSED" in proc.stdout
    assert time.monotonic() - started < 10, "run_seconds did not bound the run"
