"""P4c — the voice policy the Worker signs into every join token.

The mandate (CEO, 7 Aug 2026): an ordinary user must only be able to query
and use the voice clones attached to their own user_id. The agent is the
enforcement point — these tests pin the three layers: parsing fails CLOSED,
the allow decision hides other users' clones, and the room broadcast
narrows to the strictest policy present.
"""
import json
import types

from convert_agent import (voice_allowed, voice_policy_from_metadata)


PREMADE = {"voice_id": "stock-1", "name": "Rachel", "category": "premade"}
MY_CLONE = {"voice_id": "clone-mine", "name": "Me", "category": "cloned"}
HER_CLONE = {"voice_id": "clone-ceo", "name": "Amy", "category": "cloned"}
UNCATEGORIZED = {"voice_id": "mystery", "name": "??"}


# ── parsing: the claim, and everything that is not the claim ─────────────

def test_parse_all():
    assert voice_policy_from_metadata(json.dumps({"voicePolicy": "all"})) == ("all", None)


def test_parse_own_with_ids():
    mode, ids = voice_policy_from_metadata(
        json.dumps({"voicePolicy": "own", "voices": ["clone-mine", "clone-2"]}))
    assert mode == "own"
    assert ids == frozenset({"clone-mine", "clone-2"})


def test_parse_own_ignores_non_string_ids():
    _, ids = voice_policy_from_metadata(
        json.dumps({"voicePolicy": "own", "voices": ["ok", 7, None, {"x": 1}]}))
    assert ids == frozenset({"ok"})


def test_parse_fails_closed():
    # Every malformed shape lands on ("own", ∅): premade only, no clones.
    closed = ("own", frozenset())
    assert voice_policy_from_metadata(None) == closed
    assert voice_policy_from_metadata("") == closed
    assert voice_policy_from_metadata("not json {") == closed
    assert voice_policy_from_metadata(json.dumps(["a", "list"])) == closed
    assert voice_policy_from_metadata(json.dumps({"voicePolicy": "sudo"})) == closed
    assert voice_policy_from_metadata(json.dumps({"voicePolicy": "own"})) == closed


# ── the allow decision ───────────────────────────────────────────────────

def test_all_hears_everything():
    policy = ("all", None)
    for v in (PREMADE, MY_CLONE, HER_CLONE, UNCATEGORIZED):
        assert voice_allowed(policy, v)


def test_own_hears_premade_plus_exactly_its_clones():
    policy = ("own", frozenset({"clone-mine"}))
    assert voice_allowed(policy, PREMADE)
    assert voice_allowed(policy, MY_CLONE)
    assert not voice_allowed(policy, HER_CLONE), "another user's clone is invisible"
    assert not voice_allowed(policy, UNCATEGORIZED), \
        "unknown category is a clone-shaped stranger — hidden, not defaulted in"


# ── the room broadcast narrows to the strictest policy present ───────────

def _agent_with_room(participants):
    from convert_agent import ConvertAgent
    agent = ConvertAgent.__new__(ConvertAgent)  # no I/O, just the method's deps
    agent.room = types.SimpleNamespace(
        remote_participants={p.identity: p for p in participants})
    return agent


def _p(identity, metadata=None):
    return types.SimpleNamespace(identity=identity, metadata=metadata)


def test_room_policy_user_narrows_shared_broadcast():
    from convert_agent import ConvertAgent
    user = _p("user-7", json.dumps({"voicePolicy": "own", "voices": ["clone-mine"]}))
    ops = _p("ops-probe", json.dumps({"voicePolicy": "all"}))
    agent = _agent_with_room([ops, user])
    assert ConvertAgent._room_voice_policy(agent) == ("own", frozenset({"clone-mine"}))


def test_room_policy_agents_are_invisible_and_empty_room_is_all():
    from convert_agent import ConvertAgent
    fellow = _p("echo-convert-2", None)  # an agent identity never narrows
    assert ConvertAgent._room_voice_policy(_agent_with_room([fellow])) == ("all", None)
    assert ConvertAgent._room_voice_policy(_agent_with_room([])) == ("all", None)


def test_room_policy_metadataless_stranger_fails_closed():
    from convert_agent import ConvertAgent
    stranger = _p("someone", None)
    assert ConvertAgent._room_voice_policy(_agent_with_room([stranger])) == ("own", frozenset())


def test_room_policy_two_restricted_participants_intersect():
    # Two 'own' users with disjoint clones: the shared broadcast must carry
    # NEITHER set — returning the first policy would put user A's clone ids
    # in a broadcast user B can read. Intersection of disjoint sets is ∅.
    from convert_agent import ConvertAgent
    a = _p("user-a", json.dumps({"voicePolicy": "own", "voices": ["clone-a"]}))
    b = _p("user-b", json.dumps({"voicePolicy": "own", "voices": ["clone-b"]}))
    agent = _agent_with_room([a, b])
    assert ConvertAgent._room_voice_policy(agent) == ("own", frozenset())
    # And a shared clone survives the intersection — the rule narrows, it
    # doesn't blank.
    c = _p("user-c", json.dumps({"voicePolicy": "own", "voices": ["clone-a", "shared"]}))
    d = _p("user-d", json.dumps({"voicePolicy": "own", "voices": ["clone-b", "shared"]}))
    assert ConvertAgent._room_voice_policy(_agent_with_room([c, d])) == ("own", frozenset({"shared"}))
