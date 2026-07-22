"""LiveKit connectivity smoke test — the GATE before deploying anything.

Portable by construction: resolves secrets.env at the repo root relative to
THIS file's location, so it works unchanged on the Mac, a fresh VPS, or any
checkout path. Mints its own server-side token (never a pasted one), connects
to the room, prints CONNECTED OK, and disconnects.

If this doesn't print CONNECTED OK, nothing downstream (agents, RVC, browser)
is worth debugging yet — fix credentials/network first. See runbook.md.

Run:  python lk_smoke.py [--room luminastream-test] [--identity echo-smoke]
Exit: 0 on CONNECTED OK, 1 otherwise.
"""

import argparse
import asyncio
import os
import sys
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from livekit import api, rtc

DEFAULT_ROOM = "luminastream-test"
DEFAULT_IDENTITY = "echo-smoke"  # echo-* prefix: real agents ignore us


def load_credentials():
    repo_root = Path(__file__).resolve().parent.parent
    env_path = repo_root / "secrets.env"
    if not env_path.exists():
        sys.exit(f"FAIL: {env_path} not found")
    load_dotenv(env_path)
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not url or not key or not secret:
        sys.exit(f"FAIL: {env_path} must define LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET")
    return url, key, secret


async def smoke(room_name, identity, timeout_s):
    url, key, secret = load_credentials()
    token = (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name("Smoke Test")
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .with_ttl(timedelta(minutes=5))
        .to_jwt()
    )
    room = rtc.Room()
    try:
        await asyncio.wait_for(
            room.connect(url, token, rtc.RoomOptions(auto_subscribe=False)),
            timeout=timeout_s,
        )
        print(f"CONNECTED OK  (room={room_name} identity={identity} url={url})")
        return 0
    except Exception as exc:
        print(f"FAIL: {type(exc).__name__}: {exc}")
        return 1
    finally:
        await room.disconnect()


def main():
    ap = argparse.ArgumentParser(description="LiveKit connectivity smoke test")
    ap.add_argument("--room", default=DEFAULT_ROOM)
    ap.add_argument("--identity", default=DEFAULT_IDENTITY)
    ap.add_argument("--timeout", type=float, default=15.0, help="seconds")
    args = ap.parse_args()
    sys.exit(asyncio.run(smoke(args.room, args.identity, args.timeout)))


if __name__ == "__main__":
    main()
