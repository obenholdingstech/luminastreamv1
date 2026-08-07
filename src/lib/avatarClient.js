// Client for the avatar library (P4c). Cookie-authenticated throughout —
// the server scopes every key to the session's user; this client never even
// carries a user id, because the API surface has nowhere to put one.
//
// The #95 lessons applied from birth: an empty base is same-origin (only a
// MISSING base refuses), and an ok response whose `avatars` is not an array
// is a FAILED list, never something handed to `.map`.

import { API_BASE } from './apiBase.js';
import { deadline } from './apiFetch.js';

const MESSAGES = {
  avatars_unconfigured: 'avatar storage is not switched on yet',
  avatar_limit_reached: 'avatar limit reached — delete one to add another',
  image_invalid: 'that file could not be read as an image — JPEG, PNG, or WebP under 3.5MB',
  avatar_not_found: 'that avatar no longer exists',
  storage_unavailable: 'avatar storage did not answer — try again in a moment',
  rate_limited: 'too many attempts — wait a minute',
  unauthenticated: 'sign in to manage your avatars',
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
      // Uploads carry megabytes of base64 — longer than the chat-sized
      // default, still finite.
      signal: deadline(60_000),
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

/** @returns {Promise<Array<{id:string, name:string, size:number, selected:boolean}>|null>} null = FAILED list */
export async function listAvatars(base = API_BASE) {
  const res = await jsonFetch('/api/me/avatars', {}, base);
  if (res?.status !== 200 || !res.data?.ok || !Array.isArray(res.data.avatars)) return null;
  return res.data.avatars;
}

/**
 * @param {{ imageData: string, name?: string }} args
 * @returns {Promise<{ ok: boolean, id?: string, message?: string }>}
 */
export async function uploadAvatar(args, base = API_BASE) {
  const res = await jsonFetch('/api/me/avatars', { method: 'POST', body: args }, base);
  if (res?.status === 200 && res.data?.ok) return { ok: true, id: res.data.id };
  return { ok: false, message: refusal(res) };
}

/** @returns {Promise<{ ok: boolean, message?: string }>} */
export async function selectAvatar(id, base = API_BASE) {
  const res = await jsonFetch(
    `/api/me/avatars/${encodeURIComponent(id)}/select`,
    { method: 'POST', body: {} },
    base,
  );
  if (res?.status === 200 && res.data?.ok) return { ok: true };
  return { ok: false, message: refusal(res) };
}

/** @returns {Promise<{ ok: boolean, message?: string }>} */
export async function deleteAvatar(id, base = API_BASE) {
  const res = await jsonFetch(`/api/me/avatars/${encodeURIComponent(id)}`, { method: 'DELETE' }, base);
  if (res?.status === 200 && res.data?.ok) return { ok: true };
  return { ok: false, message: refusal(res) };
}

/**
 * Fetch the bytes for preview → object URL (an <img> cannot send the cookie
 * cross-origin on its own). CALLER owns revocation — every URL returned here
 * must eventually meet URL.revokeObjectURL or it leaks the blob.
 * @returns {Promise<string|null>}
 */
export async function avatarObjectUrl(id, base = API_BASE) {
  if (base == null) return null;
  try {
    const res = await fetch(`${base}/api/me/avatars/${encodeURIComponent(id)}`, {
      credentials: 'include',
      signal: deadline(),
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
