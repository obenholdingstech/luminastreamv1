// A fake Durable Object runtime, built for one purpose: COUNTING.
//
// The O(1) invariant (ROADMAP.md §P1) is a claim about how many times we touch
// the Durable Object, and how that number moves with session length. Nothing
// in the real runtime will tell us that on a pull request, and a ten-hour
// session cannot be waited out in CI — so the harness supplies a clock we
// control and a stub that tallies every fetch() and every alarm().
//
// Fidelity that matters, and why:
//   - storage.list returns a Map in key order, like the real one;
//   - storage.delete accepts a key or an array of keys;
//   - the pending alarm is CLEARED BEFORE alarm() runs, exactly as Cloudflare
//     does — a handler that re-arms is setting a new alarm, not keeping one;
//   - advancing time fires every alarm that comes due ON THE WAY, in order,
//     rather than jumping past them.
//
// Records are structuredClone'd in and out so a test holding a reference
// cannot mutate stored state by accident and quietly agree with itself.

// It lives in testkit/ rather than test/ deliberately: `node --test` treats
// every file under a `test/` directory as a test file, and a helper reported
// as a passing test with nothing in it is a small lie in the output.

import { SessionRegistry } from '../src/sessionRegistry.js';

export function createRegistryHarness({ env = {}, startAt = Date.now(), cls = SessionRegistry } = {}) {
  let clock = startAt;
  const store = new Map();
  let alarmAt = null;
  let requests = 0;
  let alarms = 0;

  const storage = {
    async get(key) {
      // The real DO accepts an ARRAY and answers a Map (present keys only).
      if (Array.isArray(key)) {
        const out = new Map();
        for (const k of key) {
          const v = store.get(k);
          if (v !== undefined) out.set(k, structuredClone(v));
        }
        return out;
      }
      const value = store.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(key, value) {
      store.set(key, structuredClone(value));
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      // The real API accepts at most 128 keys per call. A fake that quietly
      // swallowed 10,000 would make the chunking in #liveSessions untestable —
      // and untested chunking is chunking that gets removed by the next person
      // who finds it fussy.
      if (keys.length > 128) {
        throw new Error(`storage.delete() accepts at most 128 keys, got ${keys.length}`);
      }
      let deleted = 0;
      for (const k of keys) if (store.delete(k)) deleted += 1;
      return deleted;
    },
    async list({ prefix = '', reverse = false, limit } = {}) {
      // Real DO semantics: keys ordered, THEN reversed, THEN limited — the
      // order of those operations is exactly what the settlements-index
      // regression depends on, so the fake must not simplify it.
      let keys = [...store.keys()].sort().filter((k) => k.startsWith(prefix));
      if (reverse) keys = keys.reverse();
      if (Number.isInteger(limit)) keys = keys.slice(0, limit);
      const out = new Map();
      for (const k of keys) out.set(k, structuredClone(store.get(k)));
      return out;
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(time) {
      alarmAt = typeof time === 'number' ? time : new Date(time).getTime();
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };

  // Any Durable Object with the (state, env, now) constructor shape — the
  // SessionRegistry and the SpendLedger share it deliberately, so both get
  // the same counting fake and the same oracle discipline.
  const instance = new cls({ storage }, env, () => clock);

  // The counting stub. Every request the Worker makes into the registry passes
  // through here, which is the whole measurement.
  const stub = {
    async fetch(request) {
      requests += 1;
      return instance.fetch(request);
    },
  };

  const namespace = {
    idFromName(name) {
      return {
        name,
        toString() {
          return name;
        },
      };
    },
    get() {
      return stub;
    },
  };

  async function advanceTo(target) {
    let guard = 0;
    while (alarmAt !== null && alarmAt <= target) {
      // A reaper that re-armed to the instant it just woke for would spin
      // forever and bill for it. Catching that here turns an infinite loop
      // into a failed assertion.
      guard += 1;
      if (guard > 100) throw new Error('alarm re-armed itself in a loop');
      clock = alarmAt;
      alarmAt = null;
      alarms += 1;
      await instance.alarm();
    }
    if (target > clock) clock = target;
  }

  // Move the clock WITHOUT running anything that came due.
  //
  // Not a shortcut around advanceTo — a distinct real state. Alarm delivery can
  // be delayed (an outage, a retry), so an ordinary request can arrive at an
  // object whose leases ran out while nothing swept. What the registry must
  // never do in that window is report a dead session as live.
  function warpTo(target) {
    if (target > clock) clock = target;
  }

  return {
    namespace,
    storage,
    instance,
    now: () => clock,
    advanceTo,
    warpTo,
    warpBy: (ms) => warpTo(clock + ms),
    advanceBy: (ms) => advanceTo(clock + ms),
    counts: () => ({ requests, alarms }),
    resetCounts: () => {
      requests = 0;
      alarms = 0;
    },
    pendingAlarm: () => alarmAt,
    stored: () => new Map([...store.entries()].map(([k, v]) => [k, structuredClone(v)])),
  };
}

// Drive the registry directly, without the Worker in front of it. Used by the
// unit tests; the lifecycle oracle deliberately goes through the real HTTP
// surface instead, because that is where the request count is actually spent.
export function registryRequest(path, body) {
  return new Request(`https://session-registry.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
