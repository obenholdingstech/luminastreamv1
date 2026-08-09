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

/** @returns {Promise<object|null>} the overview, or null (failed read). */
export async function fetchOverview(base = API_BASE) {
  const res = await jsonFetch('/api/admin/overview', {}, base);
  if (res?.status !== 200 || !res.data?.ok) return null;
  return res.data;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchUsers(base = API_BASE) {
  const res = await jsonFetch('/api/admin/users', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.users)) return null;
  if (!res.data.users.every((u) => u && typeof u === 'object' && typeof u.id === 'string' && u.id)) {
    return null;
  }
  return res.data.users;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchSessions(base = API_BASE) {
  const res = await jsonFetch('/api/admin/sessions', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.sessions)) return null;
  return res.data.sessions;
}

/** @returns {Promise<Array<object>|null>} */
export async function fetchSettlements(base = API_BASE) {
  const res = await jsonFetch('/api/admin/settlements', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.settlements)) return null;
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
