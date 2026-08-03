// SpendLedger — the wall that stands before the money exists.
//
// This is the prepaid wallet enforcer from day one, temporarily wearing
// dev-cap clothes (ROADMAP.md §P2). Today it meters video seconds against
// development ceilings so a runaway loop cannot burn the company's card;
// later the SAME object and the SAME code paths enforce user wallets. Nothing
// here is throwaway, so everything here is built as if a stranger's money
// depends on it — because eventually it does.
//
// ─── the shape: reserve → settle ───────────────────────────────────────────
//
// The ledger obeys the O(1) invariant (§P1). A meter that ticks once per
// second of video is a Durable Object awake for the whole stream — the exact
// cost bug this project measured, rebuilt with money attached. Instead:
//
//   reserve  one request takes a bounded hold: min(requested, session cap,
//            remaining budget). The balance is DEBITED here, not at settle.
//   settle   one request reports actual usage and credits back the unused
//            part of the hold. Idempotent: a retried settle is a no-op.
//
// Two requests per video session, independent of its length.
//
// Debit-on-reserve is the asymmetry that protects the money. An unsettled
// reservation — closed tab, dead laptop — is reaped by a demand-driven alarm
// and resolves CONSERVATIVELY AS FULLY SPENT. Dev caps protect the card; in
// wallet mode a too-cautious hold is correctable against vendor-reported
// usage at P5 reconciliation, while a too-generous release is money gone.
// Abandonment can therefore never wedge the ledger into false zero-balance:
// expired holds resolve, they do not linger.
//
// Spoof-proofing, spelled out because this becomes wallets:
//   - the client is never the authority on spend — grants are minted here;
//   - settle requires a random bearer (hashed at rest, endToken discipline):
//     a guessed reservation id buys nothing;
//   - a settle can never exceed its reserve (usage is clamped to the grant);
//   - a second settle of the same reservation credits nothing (the record is
//     deleted on the first) — no double-refund;
//   - a zero-balance ledger refuses the grant, and no request the browser can
//     make increases what it is allowed to burn.

import { base64UrlEncode, base64UrlDecode, sha256, timingSafeEqual } from './crypto.js';

const KEY_PREFIX = 'reservation:';
const SPENT_KEY = 'spentSeconds';

// Cloudflare's storage.delete() takes at most 128 keys per call and throws
// above that (learned in the registry, kept here).
const MAX_DELETE_KEYS = 128;

// How long past its granted window a reservation may wait for its settle
// before the reaper resolves it as spent. Generous: a settle is one request,
// and reaping a session that was about to settle costs the user nothing in
// dev and is reconcilable in wallet mode — but reaping too eagerly would
// punish slow networks for existing.
export const SETTLE_SLACK_SECONDS = 120;

// The executioner's retry budget (ROADMAP §P2): an overrun costs at most
// 1 + KILL_RETRIES alarms. Small on purpose — beyond this, wall #2 holds.
export const KILL_RETRIES = 2;
export const KILL_RETRY_DELAY_MS = 30_000;

// Dev ceilings (ROADMAP.md §P2): 180 s per session, 3000 s total ≈ $60 at the
// verified $0.02/s. Env-overridable, strictly parsed, and the env can only
// ever be the authority — there is no console knob below these yet.
export const DEFAULT_MAX_VIDEO_SECONDS_PER_SESSION = 180;
export const DEFAULT_MAX_VIDEO_SECONDS_TOTAL = 3000;
const MAX_ALLOWED_SECONDS = 1_000_000; // sanity bound on any configured value

export class LedgerConfigError extends Error {}

// Malformed config is FATAL, never a silent default — the audio governor's
// rule, the registry's rule, and doubly this ledger's rule: a typo'd ceiling
// that quietly fell back would either strand video at zero or uncap the card.
function parseCount(raw, { name, fallback, min, max }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new LedgerConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LedgerConfigError(`${name} must be between ${min} and ${max}, got ${text}`);
  }
  return value;
}

function parseEnabled(raw, { name, fallback }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new LedgerConfigError(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

export function readLedgerConfig(env = {}) {
  return {
    enabled: parseEnabled(env.VIDEO_ENABLED, { name: 'VIDEO_ENABLED', fallback: true }),
    perSessionSeconds: parseCount(env.MAX_VIDEO_SECONDS_PER_SESSION, {
      name: 'MAX_VIDEO_SECONDS_PER_SESSION',
      fallback: DEFAULT_MAX_VIDEO_SECONDS_PER_SESSION,
      min: 1,
      max: MAX_ALLOWED_SECONDS,
    }),
    totalSeconds: parseCount(env.MAX_VIDEO_SECONDS_TOTAL, {
      name: 'MAX_VIDEO_SECONDS_TOTAL',
      fallback: DEFAULT_MAX_VIDEO_SECONDS_TOTAL,
      min: 1,
      max: MAX_ALLOWED_SECONDS,
    }),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const reservationKey = (id) => `${KEY_PREFIX}${id}`;

export class SpendLedger {
  // Same constructor shape as SessionRegistry, deliberately: the third
  // parameter is a clock so the lifecycle tests can run a full session in a
  // millisecond. Never passed in production.
  constructor(state, env, now = () => Date.now()) {
    this.state = state;
    this.storage = state.storage;
    this.env = env ?? {};
    this.now = now;
  }

  async fetch(request) {
    let config;
    try {
      config = readLedgerConfig(this.env);
    } catch (err) {
      if (err instanceof LedgerConfigError) {
        return json({ ok: false, error: 'ledger_misconfigured', detail: err.message }, 500);
      }
      throw err;
    }

    const { pathname } = new URL(request.url);
    if (pathname === '/reserve') return this.#reserve(config, await this.#readJson(request));
    if (pathname === '/settle') return this.#settle(await this.#readJson(request));
    if (pathname === '/bind') return this.#bind(await this.#readJson(request));
    if (pathname === '/settle-by-session') {
      return this.#settleBySession(await this.#readJson(request));
    }
    if (pathname === '/budget') return this.#budget(config);
    if (pathname === '/reset') return this.#reset();
    return json({ ok: false, error: 'not_found' }, 404);
  }

  // The reaper — and, since P2c, THE EXECUTIONER (ROADMAP §P2, committed
  // topology): an expired reservation that carries a vendor session id gets
  // its Decart session DELETEd from here. Server-authoritative,
  // vendor-executed, and honest about the difference: the DELETE can fail, so
  // it retries a BOUNDED number of times (KILL_RETRIES, each via alarm
  // re-arm — an overrun costs at most 1 + KILL_RETRIES alarms, a constant),
  // and a kill that exhausts its retries resolves the ledger anyway (the
  // debit stands) while writing an ORPHAN-FLAGGED settlement: the session may
  // be silent about its bill, never about its existence. Exposure past that
  // is bounded by wall #2 (the token's maxSessionDuration, probe-verified to
  // stop generation) and the vendor's own inactivity auto-end.
  //
  // Vendor calls happen ONLY here, never in the request-path sweep — a budget
  // read must not talk to Decart.
  async alarm() {
    const now = this.now();
    const { open, due } = await this.#partition(now);

    for (const record of due) {
      if (record.decartSessionId && this.env.DECART_API_KEY) {
        const killed = await this.#killVendorSession(record.decartSessionId);
        if (!killed && (record.killAttempts ?? 0) < KILL_RETRIES) {
          // Re-arm for another try; the record stays, nextKillAt schedules it.
          record.killAttempts = (record.killAttempts ?? 0) + 1;
          record.nextKillAt = now + KILL_RETRY_DELAY_MS;
          await this.storage.put(reservationKey(record.id), record);
          open.push(record);
          continue;
        }
        await this.#writeSettlement(record, {
          source: 'reaper',
          usedSeconds: record.grantedSeconds,
          vendorKilled: killed,
          orphanFlag: !killed,
        });
      } else {
        await this.#writeSettlement(record, {
          source: 'reaper',
          usedSeconds: record.grantedSeconds,
          vendorKilled: null,
          orphanFlag: Boolean(record.decartSessionId),
        });
      }
      await this.storage.delete(reservationKey(record.id));
    }
    await this.#rearm(open);
  }

  async #killVendorSession(decartSessionId) {
    try {
      const res = await fetch(
        `${this.env.DECART_API_BASE ?? 'https://api.decart.ai'}/v1/realtime/sessions/${decartSessionId}`,
        {
          method: 'DELETE',
          headers: { 'x-api-key': this.env.DECART_API_KEY },
          signal: AbortSignal.timeout(10_000),
        },
      );
      // 404 is a SUCCESS: the session is already gone (ended by the client,
      // the vendor's own timeout, or a previous retry that we never heard
      // confirm). Idempotent kills cannot double-fail.
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  async #writeSettlement(record, { source, usedSeconds, vendorSummary = null, vendorKilled = null, orphanFlag = false }) {
    // The audit trail (ROADMAP §P5): raw vendor summaries verbatim, distinct
    // from the deduction, read by reconciliation (P8) — never by the wallet.
    await this.storage.put(`settlement:${record.id}`, {
      reservationId: record.id,
      grantedSeconds: record.grantedSeconds,
      usedSeconds,
      overageSeconds: Math.max(
        0,
        (Number.isFinite(vendorSummary?.billedSeconds) ? Math.ceil(vendorSummary.billedSeconds) : usedSeconds) -
          record.grantedSeconds,
      ),
      source,
      vendorSummary,
      vendorKilled,
      orphanFlag,
      settledAt: this.now(),
    });
  }

  async #readJson(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async #spent() {
    return (await this.storage.get(SPENT_KEY)) ?? 0;
  }

  // Which moment a record is DUE is its expiry — or, once the executioner has
  // begun retrying its kill, the scheduled next attempt.
  #dueAt(record) {
    return Math.max(record.expiresAt ?? 0, record.nextKillAt ?? 0);
  }

  // Split records into open (not yet due) and due. Deletion of due records
  // happens in exactly two places: the alarm (which may owe the vendor a
  // DELETE first) and the request-path sweep below for records that carry NO
  // vendor session — a budget read must never talk to Decart, and must never
  // delete a record the executioner still owes a kill.
  async #partition(now) {
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    const open = [];
    const due = [];
    for (const [key, record] of stored) {
      if (!record || typeof record.expiresAt !== 'number') {
        // Malformed: unkillable and unbillable — drop it rather than let an
        // unparseable hold occupy budget forever.
        await this.storage.delete(key);
        continue;
      }
      (this.#dueAt(record) <= now ? due : open).push(record);
    }
    return { open, due };
  }

  // Request-path sweep: resolves due records WITHOUT vendor sessions (their
  // debit stands; settlement recorded as reaper-without-vendor). Records that
  // owe a vendor kill stay for the alarm — they hold no extra budget (the
  // debit was taken at reserve), so leaving them costs nothing but patience.
  async #sweep(now) {
    const { open, due } = await this.#partition(now);
    const deferred = [];
    for (const record of due) {
      if (record.decartSessionId) {
        deferred.push(record);
        continue;
      }
      await this.#writeSettlement(record, {
        source: 'reaper',
        usedSeconds: record.grantedSeconds,
      });
      await this.storage.delete(reservationKey(record.id));
    }
    return [...open, ...deferred];
  }

  async #rearm(open) {
    let next = null;
    for (const record of open) {
      const due = this.#dueAt(record);
      if (next === null || due < next) next = due;
    }
    const current = await this.storage.getAlarm();
    if (next === null) {
      if (current !== null && current !== undefined) await this.storage.deleteAlarm();
      return;
    }
    // A pending kill deferred by the request-path sweep can be due in the
    // past; clamp forward so nothing ever schedules an alarm at or before now.
    // But ONLY when nothing is already pending in the future: recomputing the
    // floor from now() on every sweep would rewrite the alarm on every budget
    // read and push the kill a second further out each time — a read path
    // that delays the executioner AND writes storage for the privilege.
    const now = this.now();
    if (next <= now) {
      if (typeof current === 'number' && current > now) return; // already armed
      next = now + 1000;
    }
    if (current !== next) await this.storage.setAlarm(next);
  }

  async #reserve(config, body) {
    if (!config.enabled) {
      return json({ ok: false, error: 'video_disabled' }, 503);
    }

    const now = this.now();
    const open = await this.#sweep(now);
    const spent = await this.#spent();
    const remaining = Math.max(0, config.totalSeconds - spent);

    // The request may ask for less than the cap (a short clip); it can never
    // get more. Absent or invalid → the full session cap.
    const requestedRaw = body?.requestedSeconds;
    const requested =
      Number.isSafeInteger(requestedRaw) && requestedRaw > 0
        ? requestedRaw
        : config.perSessionSeconds;
    const granted = Math.min(requested, config.perSessionSeconds, remaining);

    if (granted <= 0) {
      // Exhausted is not an error in the ledger's bookkeeping — it is the
      // ledger WORKING. Distinct code so the client can say something true:
      // in dev this means the wall held; in wallet mode it means "top up".
      await this.#rearm(open);
      return json(
        { ok: false, error: 'video_budget_exhausted', spentSeconds: spent, totalSeconds: config.totalSeconds },
        503,
      );
    }

    const id = crypto.randomUUID();
    const settleToken = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const record = {
      id,
      grantedSeconds: granted,
      settleTokenHash: base64UrlEncode(await sha256(settleToken)),
      createdAt: now,
      // The hold may wait its own duration plus slack for the settle; after
      // that the reaper resolves it as spent.
      expiresAt: now + (granted + SETTLE_SLACK_SECONDS) * 1000,
    };

    // DEBIT NOW. The hold is spend until proven otherwise — the asymmetry
    // that makes abandonment safe for the money rather than for the abuser.
    await this.storage.put(SPENT_KEY, spent + granted);
    await this.storage.put(reservationKey(id), record);
    await this.#rearm([...open, record]);

    return json({
      ok: true,
      reservationId: id,
      settleToken,
      grantedSeconds: granted,
      spentSeconds: spent + granted,
      remainingSeconds: Math.max(0, config.totalSeconds - spent - granted),
    });
  }

  async #settle(body) {
    const id = typeof body?.reservationId === 'string' ? body.reservationId.trim() : '';
    const settleToken = typeof body?.settleToken === 'string' ? body.settleToken : '';
    if (!id || !settleToken) {
      return json({ ok: false, error: 'reservation_and_token_required' }, 400);
    }

    const now = this.now();
    // Expiry is evaluated BEFORE the record is read — the registry's rule,
    // applied to money: Cloudflare can delay or retry alarm delivery, and a
    // settle landing in that window must NOT refund a hold that has already
    // resolved as spent. The sweep deletes expired holds first, so an expired
    // settle falls through to the idempotent unknown_reservation path and
    // credits nothing. The alarm reclaims; it does not define expiry.
    const open = await this.#sweep(now);
    const record = await this.storage.get(reservationKey(id));

    // Idempotent: settling a reservation that is gone — already settled,
    // reaped, or expired-awaiting-reap — succeeds with settled:false and
    // credits NOTHING. A retried settle must not read as failure, and must
    // never refund twice.
    if (!record) {
      await this.#rearm(open);
      return json({ ok: true, settled: false, reason: 'unknown_reservation' });
    }

    let expected;
    try {
      expected = base64UrlDecode(record.settleTokenHash ?? '');
    } catch {
      expected = new Uint8Array(0);
    }
    if (!timingSafeEqual(await sha256(settleToken), expected)) {
      // The hold stands. A wrong bearer must never move money — in either
      // direction.
      return json({ ok: false, error: 'settle_refused' }, 403);
    }

    // Usage is CLAMPED to the grant: a settle can never exceed its reserve,
    // so no request shape can spend more than was authorized. Negative,
    // missing, or garbage usage settles as fully spent — the conservative
    // reading, consistent with the reaper.
    const usedRaw = body?.usedSeconds;
    const used =
      Number.isSafeInteger(usedRaw) && usedRaw >= 0
        ? Math.min(usedRaw, record.grantedSeconds)
        : record.grantedSeconds;
    const refund = record.grantedSeconds - used;

    const spent = await this.#spent();
    // The floor guards bookkeeping, not money: spent can never go negative
    // even if a bug elsewhere shrank it first.
    await this.storage.put(SPENT_KEY, Math.max(0, spent - refund));
    // Every resolution leaves an audit row, whatever its source — the
    // client-reported dev path included, so reconciliation can tell the
    // trusted settlements from the merely clamped ones.
    await this.#writeSettlement(record, { source: 'client', usedSeconds: used });
    await this.storage.delete(reservationKey(id));
    await this.#rearm(open.filter((r) => r.id !== id));

    return json({
      ok: true,
      settled: true,
      usedSeconds: used,
      refundedSeconds: refund,
      spentSeconds: Math.max(0, spent - refund),
    });
  }

  // Attach the vendor session id to its reservation — the executioner's
  // ammunition, and the canon's required ordering: this happens BEFORE the
  // event token reaches any browser. Idempotent; a second bind with a
  // DIFFERENT id is refused (one reservation, one session, ever).
  async #bind(body) {
    const id = typeof body?.reservationId === 'string' ? body.reservationId.trim() : '';
    const sid = typeof body?.decartSessionId === 'string' ? body.decartSessionId.trim() : '';
    if (!id || !sid) return json({ ok: false, error: 'reservation_and_session_required' }, 400);

    const record = await this.storage.get(reservationKey(id));
    if (!record) return json({ ok: false, error: 'unknown_reservation' }, 404);
    if (record.decartSessionId && record.decartSessionId !== sid) {
      return json({ ok: false, error: 'already_bound' }, 409);
    }
    record.decartSessionId = sid;
    await this.storage.put(reservationKey(id), record);
    return json({ ok: true, bound: true });
  }

  // Vendor-truth settle (ROADMAP §P2): called ONLY by the Worker after it has
  // performed the vendor DELETE itself and read the billing summary from that
  // server-to-server exchange. No settle bearer here — the Durable Object is
  // reachable only through the Worker binding, and the Worker verified the
  // caller's control token before making the vendor call. Browser-supplied
  // vendor fields never reach this path (index.js constructs the payload from
  // Decart's response, not the request).
  async #settleBySession(body) {
    const sid = typeof body?.decartSessionId === 'string' ? body.decartSessionId.trim() : '';
    if (!sid) return json({ ok: false, error: 'session_required' }, 400);

    const now = this.now();
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    let record = null;
    for (const [, r] of stored) {
      if (r?.decartSessionId === sid) {
        record = r;
        break;
      }
    }
    // Idempotent like /settle: already settled or reaped → success, no credit.
    if (!record) {
      const open = await this.#sweep(now);
      await this.#rearm(open);
      return json({ ok: true, settled: false, reason: 'unknown_session' });
    }

    const vendorSummary = body?.vendorSummary && typeof body.vendorSummary === 'object'
      ? body.vendorSummary
      : null;
    // Clamped at zero: a negative or nonsense billed value must never become
    // a refund larger than the grant. Vendor numbers are trusted over the
    // client's, not over arithmetic.
    const billed = Number.isFinite(vendorSummary?.billedSeconds)
      ? Math.max(0, Math.ceil(vendorSummary.billedSeconds))
      : null;
    // The vendor's number, clamped to the grant for the DEV meter (the
    // granularity overage is recorded on the settlement for reconciliation —
    // wall #2 was measured at ~2–3 s past the constraint). Absent a usable
    // summary, conservative: fully spent.
    const used = billed === null ? record.grantedSeconds : Math.min(billed, record.grantedSeconds);
    const refund = record.grantedSeconds - used;

    const spent = await this.#spent();
    await this.storage.put(SPENT_KEY, Math.max(0, spent - refund));
    await this.#writeSettlement(record, { source: 'vendor', usedSeconds: used, vendorSummary });
    await this.storage.delete(reservationKey(record.id));
    const open = await this.#sweep(now);
    await this.#rearm(open);

    return json({
      ok: true,
      settled: true,
      usedSeconds: used,
      refundedSeconds: refund,
      overageSeconds: billed === null ? 0 : Math.max(0, billed - record.grantedSeconds),
      spentSeconds: Math.max(0, spent - refund),
    });
  }

  async #budget(config) {
    const now = this.now();
    const open = await this.#sweep(now);
    await this.#rearm(open);
    const spent = await this.#spent();
    return json({
      ok: true,
      enabled: config.enabled,
      perSessionSeconds: config.perSessionSeconds,
      totalSeconds: config.totalSeconds,
      spentSeconds: spent,
      remainingSeconds: Math.max(0, config.totalSeconds - spent),
      openReservations: open.length,
    });
  }

  // The operator escape hatch, dev-cap edition: zero the meter and drop every
  // hold. This re-arms the company card, which is exactly what an operator
  // resetting dev caps intends and exactly what a WALLET reset must never do
  // — when this object graduates to wallets (P5), reset becomes an admin
  // adjustment with an audit trail (P8), not a zeroing.
  async #reset() {
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    const keys = [...stored.keys()];
    for (let i = 0; i < keys.length; i += MAX_DELETE_KEYS) {
      await this.storage.delete(keys.slice(i, i + MAX_DELETE_KEYS));
    }
    await this.storage.put(SPENT_KEY, 0);
    if ((await this.storage.getAlarm()) !== null) await this.storage.deleteAlarm();
    return json({ ok: true, released: keys.length });
  }
}
