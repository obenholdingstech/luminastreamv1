// P5 — the rate table (ROADMAP §P5, opened on the CEO's green light,
// 7 Aug 2026 late). The retail-decoupling mandate, mechanized:
//
//   * The unit of account is CREDIT-CENTS — integers, no floats near money.
//   * Vendor units convert to credit-cents ONCE, at reserve, at the table's
//     current rate; the reservation pins {version, rate} and settle refunds
//     against the PINNED rate only. The same usage can never convert twice
//     or under two prices.
//   * Rounding is house-favouring and fixed: CEIL at debit, FLOOR at refund.
//   * The margin floor is an ENFORCED INVARIANT: a table whose retail rate
//     is below its declared COGS floor refuses to parse — fatal, never
//     silent — so selling at cost requires a deliberate, reviewed config
//     change, not an oversight.
//
// This module is pure: parsing and arithmetic only. The ledger wires it in
// behind reserve/settle in the follow-up PR; until then dev caps keep their
// 1:1 semantics via DEV_RATE_TABLE below.

/** Thrown for any malformed table — the caller's job is to make it FATAL. */
export class RateTableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateTableError';
  }
}

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v >= 1;

/**
 * Strict-parse a rate table. Shape:
 *   { version: int>=1, meters: { <name>: {
 *       cogsCentsPerUnit: int>=0, retailCentsPerUnit: int>=0 } } }
 * Refusals (all RateTableError, all fatal): non-integer money, an empty
 * meter set, and — the mandate — any retail rate below its COGS floor.
 */
export function parseRateTable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RateTableError('rate table must be an object');
  }
  if (!isPosInt(raw.version)) {
    throw new RateTableError('rate table version must be an integer >= 1');
  }
  const meterNames = Object.keys(raw.meters ?? {});
  if (meterNames.length === 0) {
    throw new RateTableError('rate table declares no meters');
  }
  const meters = {};
  for (const name of meterNames) {
    const m = raw.meters[name];
    if (m === null || typeof m !== 'object') {
      throw new RateTableError(`meter ${name} must be an object`);
    }
    if (!isNonNegInt(m.cogsCentsPerUnit) || !isNonNegInt(m.retailCentsPerUnit)) {
      throw new RateTableError(
        `meter ${name}: cogsCentsPerUnit and retailCentsPerUnit must be non-negative integers — no floats near money`,
      );
    }
    if (m.retailCentsPerUnit < m.cogsCentsPerUnit) {
      throw new RateTableError(
        `meter ${name}: retail ${m.retailCentsPerUnit} is below the COGS floor ${m.cogsCentsPerUnit} — selling at a loss requires changing the declared floor, deliberately`,
      );
    }
    meters[name] = {
      cogsCentsPerUnit: m.cogsCentsPerUnit,
      retailCentsPerUnit: m.retailCentsPerUnit,
    };
  }
  return Object.freeze({ version: raw.version, meters: Object.freeze(meters) });
}

/**
 * Convert a reservation's grant to credit-cents at the CURRENT table —
 * the once-and-only conversion. CEIL: partial cents debit whole.
 * @returns {{ creditCents: number, rateVersion: number, rateCentsPerUnit: number }}
 */
export function convertAtReserve(table, meterName, units) {
  const meter = table.meters[meterName];
  if (!meter) throw new RateTableError(`unknown meter: ${meterName}`);
  if (!(Number.isFinite(units) && units >= 0)) {
    throw new RateTableError('units must be a non-negative finite number');
  }
  return {
    creditCents: Math.ceil(units * meter.retailCentsPerUnit),
    rateVersion: table.version,
    rateCentsPerUnit: meter.retailCentsPerUnit,
  };
}

/**
 * The refund of unused grant at settle — against the PINNED rate, never a
 * current table (which is deliberately not a parameter: passing it here
 * would be the two-prices bug waiting for an author). FLOOR: partial cents
 * stay with the house. Clamped: vendor-reported over-usage refunds zero,
 * it never mints a negative refund.
 */
export function refundAtSettle(pinned, grantedUnits, usedUnits) {
  if (!isNonNegInt(pinned?.rateCentsPerUnit)) {
    throw new RateTableError('a settle without its pinned rate cannot refund — the reservation record is the authority');
  }
  const unused = Math.max(0, grantedUnits - Math.max(0, usedUnits));
  return Math.floor(unused * pinned.rateCentsPerUnit);
}

// Dev semantics until wallets exist (ROADMAP: "dev caps run at rate 1:1 — a
// second is a second"): one credit-cent per vendor unit, zero declared COGS
// so the floor invariant holds vacuously. Replaced by real config when P5's
// wallet lands; the shape is identical so that swap is a value change.
export const DEV_RATE_TABLE = parseRateTable({
  version: 1,
  meters: {
    decart_video_seconds: { cogsCentsPerUnit: 0, retailCentsPerUnit: 1 },
  },
});
