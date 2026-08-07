// Client for the per-user voice library (P4c-3). Cookie-authenticated —
// the server scopes every row to the session's user, so this client never
// carries a user id; the API surface has nowhere to put one.
//
// Errors come back as short prose the panel can show verbatim. The one that
// matters most is the FAIL-CLOSED wall: until the vendor key exists on the
// Worker, cloning answers 503 voice_vendor_unconfigured — which is the wall
// working, and the message says so instead of pretending to be an outage.

import { API_BASE } from './apiBase.js';
import { deadline } from './apiFetch.js';

const CLONE_MESSAGES = {
  voice_vendor_unconfigured: 'voice cloning is not switched on yet — the vendor key is pending',
  voice_limit_reached: 'voice limit reached — delete one to clone another',
  verification_required: 'verify your email first — cloning spends real quota',
  sample_invalid: 'that file could not be read as audio — try an MP3 or WAV under 10MB',
  voice_clone_rejected: 'the voice provider refused this sample — longer, cleaner speech works best',
  vendor_unreachable: 'the voice provider did not answer — try again in a moment',
  rate_limited: 'too many attempts — wait a minute',
  unauthenticated: 'sign in to manage your voices',
};

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<{ status: number, data: any } | null>}
 */
async function jsonFetch(path, { method = 'GET', body } = {}, base = API_BASE) {
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: 'include',
      // Clone uploads carry megabytes of base64 — a longer deadline than
      // the default chat-sized one, still finite.
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
  const code = res?.data?.error;
  return CLONE_MESSAGES[code] ?? 'that did not work — try again';
}

/** @returns {Promise<Array<{id:string, voiceId:string, label:string}>|null>} */
export async function listMyVoices(base = API_BASE) {
  const res = await jsonFetch('/api/me/voices', {}, base);
  return res?.status === 200 && res.data?.ok ? res.data.voices : null;
}

/**
 * @param {{ name: string, sampleData: string, mimeType?: string }} args
 * @returns {Promise<{ ok: boolean, voiceId?: string, message?: string }>}
 */
export async function cloneMyVoice(args, base = API_BASE) {
  const res = await jsonFetch('/api/me/voices', { method: 'POST', body: args }, base);
  if (res?.status === 200 && res.data?.ok) return { ok: true, voiceId: res.data.voiceId };
  return { ok: false, message: refusal(res) };
}

/** @returns {Promise<{ ok: boolean, message?: string }>} */
export async function deleteMyVoice(id, base = API_BASE) {
  const res = await jsonFetch(`/api/me/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }, base);
  if (res?.status === 200 && res.data?.ok) return { ok: true };
  return { ok: false, message: refusal(res) };
}
