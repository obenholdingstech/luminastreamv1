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
// costs 1 request and exactly 1 alarm, whether it was abandoned after a minute
// or after a day.

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

// One, because that is the truth today: one agent, one room. The registry's
// job at this capacity is already worth having — the second caller is refused
// with a reason instead of being silently ignored by a busy agent. P1c
// measures the real capacity constant on the VPS and this becomes that number.
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

export function readRegistryConfig(env = {}) {
  return {
    capacity: parseCount(env.MAX_CONCURRENT_SESSIONS, {
      name: 'MAX_CONCURRENT_SESSIONS',
      fallback: DEFAULT_MAX_CONCURRENT_SESSIONS,
      min: 1,
      max: MAX_ALLOWED_CONCURRENT_SESSIONS,
    }),
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

    if (live.length >= config.capacity) {
      await this.#rearm(live);
      return json(
        { ok: false, error: 'at_capacity', live: live.length, capacity: config.capacity },
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
      room: `lumina-${id}`,
      // LiveKit evicts on duplicate identity. Each session gets its own room so
      // a collision across rooms would be harmless anyway, but deriving from
      // the uuid makes one impossible rather than merely unlikely.
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
