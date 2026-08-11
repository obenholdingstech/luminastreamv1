// Client for the admin API (P8). Cookie-authenticated; the server holds the
// role wall — this client never carries a token because none exists for
// people-administration. Born with the #95 lessons: array-validated lists
// (a malformed 200 is a FAILED read), empty base = same-origin, refusals as
// prose the console shows verbatim.

import { API_BASE } from './apiBase.js';
import { deadline } from './apiFetch.js';

const MESSAGES = {
  unauthenticated: 'your session ended — sign in again',
  admin_only: 'this account is not an admin',
  cannot_change_own_status: 'you cannot suspend your own account',
  user_not_found: 'that user no longer exists',
  status_invalid: 'that is not a valid status',
  rate_limited: 'too many requests — wait a minute',
};

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<{ status: number, data: any } | null>}
 */
async function jsonFetch(path, { method = 'GET', body } = {}, base = API_BASE) {
  if (base == null) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: 'include',
      signal: deadline(),
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

function refusal(res) {
  return MESSAGES[res?.data?.error] ?? 'that did not work — try again';
}

// Every field the console RENDERS is validated here (CodeRabbit, PR 103):
// an ok-shaped answer with a missing count or a null row must be a FAILED
// read the panel retries — never invented zeros, never a table crash.
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isStr = (v) => typeof v === 'string' && v.length > 0;

function isOverview(d) {
  const u = d?.users;
  return (
    u !== null &&
    typeof u === 'object' &&
    isCount(u.total) &&
    isCount(u.active) &&
    isCount(u.suspended) &&
    isCount(u.admins) &&
    (d.capacity === null || typeof d.capacity === 'object') &&
    (d.videoBudget === null || typeof d.videoBudget === 'object') &&
    typeof d.voiceCloningEnabled === 'boolean'
  );
}

const isUserRow = (u) =>
  u !== null &&
  typeof u === 'object' &&
  isStr(u.id) &&
  (u.email === null || typeof u.email === 'string') &&
  isStr(u.status) &&
  isStr(u.role) &&
  typeof u.verified === 'boolean' &&
  isCount(u.voices) &&
  isCount(u.avatars) &&
  isCount(u.createdAt);

const isSessionRow = (s) =>
  s !== null && typeof s === 'object' && isStr(s.id) && isStr(s.room) && isCount(s.started_at);

const isSettlementRow = (s) =>
  s !== null &&
  typeof s === 'object' &&
  isStr(s.reservationId) &&
  isCount(s.grantedSeconds) &&
  isCount(s.usedSeconds);

/** @returns {Promise<object|null>} the overview, or null (failed read). */
export async function fetchOverview(base = API_BASE) {
  const res = await jsonFetch('/api/admin/overview', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !isOverview(res.data)) return null;
  return res.data;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchUsers(base = API_BASE) {
  const res = await jsonFetch('/api/admin/users', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.users)) return null;
  if (!res.data.users.every(isUserRow)) return null;
  return res.data.users;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchSessions(base = API_BASE) {
  const res = await jsonFetch('/api/admin/sessions', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.sessions)) return null;
  if (!res.data.sessions.every(isSessionRow)) return null;
  return res.data.sessions;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchSettlements(base = API_BASE) {
  const res = await jsonFetch('/api/admin/settlements', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.settlements)) return null;
  if (!res.data.settlements.every(isSettlementRow)) return null;
  return res.data.settlements;
}

/**
 * @param {string} userId
 * @param {'active'|'suspended'} status
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function setUserStatus(userId, status, base = API_BASE) {
  const res = await jsonFetch(
    `/api/admin/users/${encodeURIComponent(userId)}/status`,
    { method: 'POST', body: { status } },
    base,
  );
  if (res?.status === 200 && res.data?.ok) return { ok: true };
  return { ok: false, message: refusal(res) };
}

/**
 * The health screen's read: vendor-key rows + agent rows, validated to the
 * fields the tables render. null = FAILED read (error state + retry).
 * @returns {Promise<{vendors: Array, agents: Array, checkedAt: number}|null>}
 */
export async function fetchHealth(base = API_BASE) {
  const res = await jsonFetch('/api/admin/health', {}, base);
  if (res?.status !== 200 || !res.data?.ok) return null;
  const { vendors, agents, checkedAt } = res.data;
  if (!Array.isArray(vendors) || !Array.isArray(agents) || !Number.isFinite(checkedAt)) return null;
  // Every field the tables RENDER is validated (CodeRabbit, PR 107):
  // quota: {} would crash toLocaleString; an object detail would render as
  // a React child. Malformed rows make the whole read FAIL (retry state).
  const isQuota = (q) =>
    q === null ||
    q === undefined ||
    (typeof q === 'object' &&
      q !== null &&
      Number.isFinite(q.used) &&
      Number.isFinite(q.limit) &&
      q.limit > 0);
  const optStr = (v) => v === null || v === undefined || typeof v === 'string';
  const vendorOk = vendors.every(
    (v) =>
      v && typeof v === 'object' &&
      typeof v.vendor === 'string' &&
      typeof v.fingerprint === 'string' &&
      typeof v.status === 'string' &&
      isQuota(v.quota) &&
      optStr(v.detail),
  );
  const agentOk = agents.every(
    (a) =>
      a && typeof a === 'object' &&
      typeof a.room === 'string' &&
      (a.agentLive === null || a.agentLive === undefined || typeof a.agentLive === 'boolean') &&
      optStr(a.agentIdentity) &&
      (a.participants === null || a.participants === undefined || Number.isFinite(a.participants)) &&
      optStr(a.detail),
  );
  if (!vendorOk || !agentOk) return null;
  return { vendors, agents, checkedAt };
}
