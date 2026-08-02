// SessionRegistry — the Durable Object that decides who gets a room.
//
// This is the project's first server-side storage, and it is NOT the database
// (that is P4). What lives here is coordination state: which sessions are
// live, which room and identity each one holds, and when each one's claim
// expires. It exists because "how many sessions are running?" has to have one
// answer even when two people press Start in the same millisecond, and a
// stateless Worker cannot give one.
//
// ─── The O(1) invariant (ROADMAP.md §P1) ──────────────────────────────────
//
// DO requests per session must be a CONSTANT, independent of how long the
// session lasts. Never O(session duration).
//
// A Durable Object is billed for its allocated 128 MB whenever it is awake and
// hibernates after 10 s of silence, so the expensive mistake is not calling it
// too often — it is never letting it sleep. On Workers Free that shows up as
// refused operations at ~55 sessions/day rather than a bill. The five rules
// this file obeys, from that section:
//
//   1. No polling. The browser is told its room once, at create.
//   2. No heartbeats. Agent liveness is not this object's business.
//   3. No non-hibernating WebSocket. There is no WebSocket here at all.
//   4. No setTimeout/setInterval — a pending timer makes the object ineligible
//      for hibernation ENTIRELY, with no symptom other than the bill. Deferred
//      work uses alarm(). A test greps this file to keep it true.
//   5. The reaper alarm is demand-driven: ONE alarm, always set to the
//      earliest pending expiry, re-armed on wake. A fixed-interval sweep would
//      make wakeups scale with session duration — breaking the very invariant
//      it was meant to serve.
//
// The whole object is therefore three storage-touching operations and one
// alarm handler, all built from the same two primitives (#liveSessions and
// #rearm). A clean session costs 3 requests and 0 alarms; an abandoned one
// costs 1 request and AT MOST 1 alarm — no matter how far into its lease it was
// abandoned, and no matter how long the object then sits idle afterwards.
//
// At most, not exactly: one wakeup reaps everything expired, so sessions
// sharing an expiry instant cost one alarm between them rather than one each.
// The bound is the number of DISTINCT PENDING EXPIRIES — at most one per
// session, and often exactly that, since a lease runs from creation and
// sessions started at different moments expire at different moments.
//
// The half that carries the invariant is that the bound does not grow with
// ELAPSED TIME: alarm count is bounded by how many sessions were abandoned,
// never by how long anything ran or how long this object then sat idle.
//
// A session cannot be abandoned "after a day" either, because it cannot outlive
// its lease; what can last a day is the silence that follows, which is exactly
// what a fixed-interval reaper would bill for.

import { base64UrlEncode, base64UrlDecode, sha256, timingSafeEqual } from './crypto.js';
import { MAX_LIVEKIT_TTL_SECONDS } from './livekit.js';

const KEY_PREFIX = 'session:';

// Cloudflare's storage.delete() takes an array, but no more than 128 keys in
// one call. Exceeding it throws — which would strand the whole sweep.
const MAX_DELETE_KEYS = 128;

// ─── lease and capacity ────────────────────────────────────────────────────
//
// The lease is the one number that makes a heartbeat unnecessary. A session
// holds its slot for a fixed span decided at create; the LiveKit grant is
// minted for that SAME span, so the slot and the credential that can occupy it
// die together and cannot drift apart. Nothing has to check in to stay alive,
// which is precisely why rule 2 costs us nothing.
//
// It is deliberately two things at once, and both matter:
//   - the maximum length of a session, and
//   - the maximum time an ABANDONED slot stays held before the reaper frees it.
// Two hours is the compromise. Longer would let a closed browser tab hold a
// slot for most of a working day; much shorter would cut live sessions off.
// P1b narrows the abandonment window without shortening the maximum, by having
// the lens release its own slot on unload (sendBeacon) — which is an event,
// not a poll.
export const DEFAULT_LEASE_SECONDS = 2 * 60 * 60; // 2h
export const MIN_LEASE_SECONDS = 60;
// A lease may never outlive the grant it is minted against: a slot held past
// its token's expiry is a slot nobody can use. livekit.js owns that ceiling,
// and importing it here is the coupling that keeps the two honest.
export const MAX_LEASE_SECONDS = MAX_LIVEKIT_TTL_SECONDS;

// ─── the room pool ─────────────────────────────────────────────────────────
//
// **A session slot IS a room with an agent in it.** Nothing else is a slot.
//
// The first cut of this file invented a room name per session — `lumina-<uuid>`
// — which reads fine and is wrong: no agent joins a name we made up a moment
// ago, so the browser would connect to an empty room, publish its microphone,
// and wait forever for a reply. The registry would report a healthy session the
// whole time. That is capacity as an assertion rather than a fact.
//
// So rooms are ALLOCATED from a pool of rooms an agent is actually serving.
// Today the pool has one entry, because there is one agent. P1c grows it by
// running more (`convert_agent.py --room <name>`, already a first-class flag)
// and listing them here. Capacity stops being a number we assert and becomes a
// consequence of how many agents are running — which is the only version of it
// that can be trusted.
export const DEFAULT_SESSION_ROOMS = 'luminastream-test';
const MAX_ROOM_NAME_LENGTH = 128;
const MAX_POOL_SIZE = 1_000;

// A policy ceiling on top of the physical one. Effective capacity is
// min(pool size, MAX_CONCURRENT_SESSIONS), so this knob can only ever admit
// FEWER sessions than there are agents — never more. Same shape as the audio
// governor: an adjustable cap that cannot breach the hard limit above it.
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;
const MAX_ALLOWED_CONCURRENT_SESSIONS = 10_000;

export class RegistryConfigError extends Error {}

// Malformed config is FATAL, never a silent default — the same rule
// agent/spend_governor.py proves for the audio governor. A typo'd
// MAX_CONCURRENT_SESSIONS that quietly fell back to 1 would look exactly like
// a working registry until someone wondered why capacity never went up; a
// typo'd one that quietly fell back to a LARGE default would over-admit
// sessions onto an agent that cannot serve them.
function parseCount(raw, { name, fallback, min, max }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new RegistryConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RegistryConfigError(`${name} must be between ${min} and ${max}, got ${text}`);
  }
  return value;
}

// The pool, parsed strictly for the same reason the counts are.
//
// The duplicate check is the one that earns its keep. A room listed twice would
// let the registry hand the same room to two sessions, and LiveKit evicts on
// duplicate identity — so the second speaker would silently kick the first out
// of a call they were mid-sentence in. It presents as a flaky connection, never
// as a configuration error, which is exactly the failure this repo has already
// paid to learn once (see sessionIdentity.js).
function parseRooms(raw, { name, fallback }) {
  const text = raw === undefined || raw === null || String(raw).trim() === ''
    ? fallback
    : String(raw);
  const rooms = text.split(',').map((entry) => entry.trim());

  for (const room of rooms) {
    if (!room) {
      throw new RegistryConfigError(
        `${name} has an empty entry — check for a stray or trailing comma`,
      );
    }
    if (room.length > MAX_ROOM_NAME_LENGTH) {
      throw new RegistryConfigError(
        `${name} has a room name longer than ${MAX_ROOM_NAME_LENGTH} characters`,
      );
    }
  }
  if (new Set(rooms).size !== rooms.length) {
    throw new RegistryConfigError(
      `${name} lists the same room twice — two sessions would be handed one room, ` +
        'and LiveKit evicts on duplicate identity',
    );
  }
  if (rooms.length > MAX_POOL_SIZE) {
    throw new RegistryConfigError(`${name} lists more than ${MAX_POOL_SIZE} rooms`);
  }
  return rooms;
}

export function readRegistryConfig(env = {}) {
  const rooms = parseRooms(env.SESSION_ROOMS, {
    name: 'SESSION_ROOMS',
    fallback: DEFAULT_SESSION_ROOMS,
  });
  const maxConcurrentSessions = parseCount(env.MAX_CONCURRENT_SESSIONS, {
    name: 'MAX_CONCURRENT_SESSIONS',
    fallback: DEFAULT_MAX_CONCURRENT_SESSIONS,
    min: 1,
    max: MAX_ALLOWED_CONCURRENT_SESSIONS,
  });

  return {
    rooms,
    maxConcurrentSessions,
    // The physical limit and the policy limit, resolved into one number. The
    // pool can never be exceeded — there is no slot without an agent — and the
    // policy cap can only lower it further.
    capacity: Math.min(rooms.length, maxConcurrentSessions),
    leaseSeconds: parseCount(env.SESSION_LEASE_SECONDS, {
      name: 'SESSION_LEASE_SECONDS',
      fallback: DEFAULT_LEASE_SECONDS,
      min: MIN_LEASE_SECONDS,
      max: MAX_LEASE_SECONDS,
    }),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function sessionKey(id) {
  return `${KEY_PREFIX}${id}`;
}

// What the caller is allowed to see. endTokenHash never leaves the object.
function publicRecord(record) {
  return {
    id: record.id,
    room: record.room,
    identity: record.identity,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export class SessionRegistry {
  // Cloudflare constructs this as `new SessionRegistry(state, env)`. The third
  // parameter is a clock, so the lifecycle tests can run a ten-hour session in
  // a millisecond. It is never passed in production.
  constructor(state, env, now = () => Date.now()) {
    this.state = state;
    this.storage = state.storage;
    this.env = env ?? {};
    this.now = now;
  }

  async fetch(request) {
    let config;
    try {
      config = readRegistryConfig(this.env);
    } catch (err) {
      if (err instanceof RegistryConfigError) {
        return json({ ok: false, error: 'registry_misconfigured', detail: err.message }, 500);
      }
      throw err;
    }

    const { pathname } = new URL(request.url);
    if (pathname === '/create') return this.#create(config);
    if (pathname === '/capacity') return this.#capacity(config);
    if (pathname === '/end') return this.#end(await this.#readJson(request));
    return json({ ok: false, error: 'not_found' }, 404);
  }

  // The reaper. Rule 5's whole point: this runs when the earliest lease
  // expires and at no other time. A session that ends cleanly never wakes it.
  async alarm() {
    const now = this.now();
    const live = await this.#liveSessions(now);
    await this.#rearm(live);
  }

  async #readJson(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  // Sweep and report. Expiry is evaluated on every path that touches storage,
  // so a session whose lease has run out is never counted as live even if the
  // alarm has not fired yet — the alarm frees the SLOT, it is not what defines
  // whether one is held.
  //
  // A record that is missing or malformed is treated as expired and deleted. A
  // single unparseable value must not be able to occupy a capacity slot
  // permanently with no way to clear it.
  async #liveSessions(now) {
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    const live = [];
    const dead = [];
    for (const [key, record] of stored) {
      if (!record || typeof record.expiresAt !== 'number' || record.expiresAt <= now) {
        dead.push(key);
      } else {
        live.push(record);
      }
    }
    // storage.delete() accepts at most 128 keys per call, and
    // MAX_CONCURRENT_SESSIONS permits far more than that. The batch only
    // matters in the case where it would hurt most — every lease expiring at
    // once, on a busy registry, with the reaper as the only thing that can
    // clear them.
    for (let i = 0; i < dead.length; i += MAX_DELETE_KEYS) {
      await this.storage.delete(dead.slice(i, i + MAX_DELETE_KEYS));
    }
    return live;
  }

  // ONE alarm, always at the earliest pending expiry — never a fixed interval.
  //
  // A sweep every N minutes would wake this object ⌈duration/N⌉ times per open
  // session, and alarm invocations bill as requests, so the cost of a session
  // would grow with its length. That is the exact shape the invariant forbids.
  //
  // Called after every sweep, so the alarm cannot outlive the sessions it was
  // set for: the last session leaving deletes it.
  async #rearm(live) {
    let next = null;
    for (const record of live) {
      if (next === null || record.expiresAt < next) next = record.expiresAt;
    }

    const current = await this.storage.getAlarm();
    if (next === null) {
      if (current !== null && current !== undefined) await this.storage.deleteAlarm();
      return;
    }
    // Only write when it actually moves. Re-arming to the same instant on
    // every read would be harmless but noisy, and the equality is what the
    // lifecycle test asserts against to detect a fixed-interval reaper.
    if (current !== next) await this.storage.setAlarm(next);

    // `next > now` always holds here: #liveSessions has just deleted
    // everything at or before now, so nothing can schedule an alarm in the
    // past and there is no way for alarm() to re-trigger itself in a loop.
  }

  async #create(config) {
    const now = this.now();
    const live = await this.#liveSessions(now);

    // Allocate a room nobody is holding. Two checks, not one, and they are
    // meant to agree: with each live session holding a distinct pool room,
    // `live.length < capacity` implies a free room exists. Asking the pool
    // directly anyway means a state that somehow disagrees refuses the session
    // rather than handing out an occupied room — the failure that would evict
    // whoever was already in it.
    const held = new Set(live.map((record) => record.room));
    const room = config.rooms.find((candidate) => !held.has(candidate));

    if (live.length >= config.capacity || !room) {
      await this.#rearm(live);
      return json(
        {
          ok: false,
          error: 'at_capacity',
          live: live.length,
          capacity: config.capacity,
          pool: config.rooms.length,
        },
        503,
      );
    }

    const id = crypto.randomUUID();
    // The bearer that releases this slot. Random, not derived from the id, so
    // knowing a session exists is not enough to end it — which matters from
    // P1b, when the lens calls this without an admin token.
    const endToken = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

    const record = {
      id,
      // From the pool — a room an agent is in — never a name invented here.
      room,
      // LiveKit evicts on duplicate identity, and pool rooms are reused across
      // sessions, so this genuinely has to be unique rather than merely tidy.
      // Deriving it from the uuid makes a collision impossible.
      identity: `speaker-${id.slice(0, 8)}`,
      // Stored hashed. This is our own storage, but a hash costs one SHA-256
      // and makes a leaked dump useless for taking over sessions.
      endTokenHash: base64UrlEncode(await sha256(endToken)),
      createdAt: now,
      expiresAt: now + config.leaseSeconds * 1000,
    };

    await this.storage.put(sessionKey(id), record);
    await this.#rearm([...live, record]);

    return json({
      ok: true,
      session: publicRecord(record),
      endToken,
      leaseSeconds: config.leaseSeconds,
      live: live.length + 1,
      capacity: config.capacity,
    });
  }

  async #capacity(config) {
    const now = this.now();
    const live = await this.#liveSessions(now);
    await this.#rearm(live);
    return json({
      ok: true,
      live: live.length,
      capacity: config.capacity,
      available: Math.max(0, config.capacity - live.length),
      // Reported separately so an operator can tell the two limits apart:
      // `pool` is how many rooms have an agent, `capacity` is what policy
      // allows. When they differ, capacity is being held down deliberately —
      // not because we ran out of agents.
      pool: config.rooms.length,
    });
  }

  async #end(body) {
    const id = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    const endToken = typeof body?.endToken === 'string' ? body.endToken : '';
    if (!id || !endToken) {
      return json({ ok: false, error: 'session_and_token_required' }, 400);
    }

    const now = this.now();
    const record = await this.storage.get(sessionKey(id));

    // Ending a session that is already gone is a SUCCESS, not an error. The
    // release call is the kind that gets retried — a page unload beacon, a
    // reconnect — and a second one must not read as a failure. That does mean
    // an unknown id is distinguishable from a wrong token; the id is a v4
    // uuid, so learning that one exists requires already having it.
    if (!record) {
      const live = await this.#liveSessions(now);
      await this.#rearm(live);
      return json({ ok: true, ended: false, reason: 'unknown_session', live: live.length });
    }

    const presented = await sha256(endToken);
    let expected;
    try {
      expected = base64UrlDecode(record.endTokenHash ?? '');
    } catch {
      expected = new Uint8Array(0);
    }
    if (!timingSafeEqual(presented, expected)) {
      // The slot stays held. A wrong token must never free someone else's
      // session — that would be a denial of service with a one-line request.
      return json({ ok: false, error: 'end_refused' }, 403);
    }

    await this.storage.delete(sessionKey(id));
    const live = await this.#liveSessions(now);
    await this.#rearm(live);
    return json({ ok: true, ended: true, live: live.length });
  }
}
