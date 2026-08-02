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
import queue
import re
import signal
import subprocess
import sys
import textwrap
import threading
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
        # READY is announced with call_soon, NOT printed before the await.
        #
        # wait_for_stop installs its signal handlers synchronously and only then
        # awaits, so a call_soon callback cannot run until installation is done —
        # control does not return to the loop before that point. Printing READY
        # on the line above instead would announce readiness BEFORE the handlers
        # exist, and a signal arriving in that window gets the interpreter's
        # default disposition: SIGTERM kills the process outright, SIGINT raises
        # KeyboardInterrupt. Which is a race, not a failure of the agent — and
        # one that macOS timing happened to hide while Linux lost it every time.
        asyncio.get_running_loop().call_soon(lambda: print("READY", flush=True))
        await wait_for_stop()
        print("CLEAN", flush=True)

    asyncio.run(main())
    """
)


# add_signal_handler is not implemented on every platform — wait_for_stop
# deliberately falls through to default handling there, which these tests are
# not asserting about.
_HAS_LOOP_SIGNALS = hasattr(signal, "SIGTERM") and os.name == "posix"


def _reap(proc):
    """Kill and collect, so a failed assertion never leaves an orphan behind."""
    if proc.poll() is None:
        proc.kill()
    try:
        return proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover - the kill did not take
        return ("", "")


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

    # Read on a thread rather than calling readline() directly. readline blocks
    # until a newline arrives, so a child that hangs before printing anything
    # would block here FOREVER and the deadline below would never be evaluated
    # — a hung test rather than a failed one, which is strictly worse: it burns
    # the CI job's whole timeout and reports nothing.
    # The thread OWNS proc.stdout for the rest of the process's life, which is
    # why the queue is handed back to the caller. communicate() cannot be used
    # for stdout afterwards — the pipe is already drained and it would return
    # an empty string, which reads exactly like "the child printed nothing".
    lines = queue.Queue()

    def pump():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)  # EOF sentinel

    threading.Thread(target=pump, daemon=True).start()

    deadline = time.monotonic() + 10
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _reap(proc)
            raise AssertionError("harness never became READY within 10s")
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            continue
        if line is None:
            _, err = _reap(proc)
            raise AssertionError(f"harness exited before READY:\n{err}")
        if line.strip() == "READY":
            return proc, lines


def _drain(lines, timeout):
    """Everything the child printed after READY, up to EOF."""
    out = []
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "".join(out)
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return "".join(out)
        if line is None:
            return "".join(out)
        out.append(line)


@pytest.mark.skipif(
    not _HAS_LOOP_SIGNALS,
    reason="loop signal handlers are POSIX-only; wait_for_stop falls back elsewhere",
)
@pytest.mark.parametrize("signame", ["SIGINT", "SIGTERM"])
def test_stops_cleanly_and_exits_zero(signame):
    """Both signals shut down cleanly, and the exit status says 'fine'."""
    proc, lines = _spawn()
    proc.send_signal(getattr(signal, signame))

    out = _drain(lines, timeout=15)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        _reap(proc)
        pytest.fail(f"{signame} did not stop the agent within 15s")
    err = proc.stderr.read()

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
    # The duration is measured INSIDE the child, around the await alone.
    #
    # Timing the subprocess from out here would include interpreter startup and
    # importing convert_agent — which pulls numpy and torch and costs well over
    # a second. A lower bound on that total is satisfied by the imports no
    # matter what wait_for_stop does, so the assertion would pass even with
    # run_seconds ignored entirely. Verified: mutating the timeout to 0.001
    # failed nothing until this measurement moved inside.
    harness = textwrap.dedent(
        f"""
        import asyncio, sys, time
        sys.path.insert(0, {AGENT_DIR!r})
        from convert_agent import wait_for_stop

        async def main():
            t0 = time.monotonic()
            await wait_for_stop(run_seconds=0.4)
            print("WAITED %.4f" % (time.monotonic() - t0), flush=True)

        asyncio.run(main())
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", harness],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    match = re.search(r"WAITED ([0-9.]+)", proc.stdout)
    assert match, f"harness did not report a duration:\n{proc.stdout}\n{proc.stderr}"
    waited = float(match.group(1))

    # BOTH bounds. An upper bound alone cannot fail on the behaviour this test
    # names: if run_seconds were ignored and the wait returned immediately,
    # "finished quickly" would still hold and the test would guard nothing.
    assert waited >= 0.3, f"run_seconds was not honoured — waited {waited:.4f}s"
    assert waited < 5, f"run_seconds did not bound the run ({waited:.2f}s)"
