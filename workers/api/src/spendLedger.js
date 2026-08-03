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
    if (pathname === '/budget') return this.#budget(config);
    if (pathname === '/reset') return this.#reset();
    return json({ ok: false, error: 'not_found' }, 404);
  }

  // The reaper: expired unsettled reservations resolve as FULLY SPENT — the
  // debit taken at reserve simply stands, so reaping is deletion, never
  // arithmetic. One demand-driven alarm at the earliest expiry, re-armed on
  // wake (§P1 rule 5); a session that settles cleanly never wakes it.
  async alarm() {
    const open = await this.#sweep(this.now());
    await this.#rearm(open);
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

  // Delete expired reservations (their debit stands) and return the open ones.
  // Malformed records are treated as expired: an unparseable hold must not
  // occupy budget forever with no way to clear it.
  async #sweep(now) {
    const stored = await this.storage.list({ prefix: KEY_PREFIX });
    const open = [];
    const dead = [];
    for (const [key, record] of stored) {
      if (!record || typeof record.expiresAt !== 'number' || record.expiresAt <= now) {
        dead.push(key);
      } else {
        open.push(record);
      }
    }
    for (let i = 0; i < dead.length; i += MAX_DELETE_KEYS) {
      await this.storage.delete(dead.slice(i, i + MAX_DELETE_KEYS));
    }
    return open;
  }

  async #rearm(open) {
    let next = null;
    for (const record of open) {
      if (next === null || record.expiresAt < next) next = record.expiresAt;
    }
    const current = await this.storage.getAlarm();
    if (next === null) {
      if (current !== null && current !== undefined) await this.storage.deleteAlarm();
      return;
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
    const record = await this.storage.get(reservationKey(id));

    // Idempotent: settling a reservation that is gone — already settled, or
    // reaped — succeeds with settled:false and credits NOTHING. A retried
    // settle must not read as failure, and must never refund twice.
    if (!record) {
      const open = await this.#sweep(now);
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
    await this.storage.delete(reservationKey(id));
    const open = await this.#sweep(now);
    await this.#rearm(open);

    return json({
      ok: true,
      settled: true,
      usedSeconds: used,
      refundedSeconds: refund,
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
