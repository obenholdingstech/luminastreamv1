// P4b-ui — the browser half of the auth API. A thin, injectable client:
// every call carries credentials (the session is an HttpOnly cookie the page
// can never read — the browser attaches it, we just ask), every server error
// token maps to ONE human sentence here (the UI owns no prose tables), and
// network failures resolve to a result object, never a throw — a sign-in
// form that can crash is worse than one that says "try again".

import { API_BASE } from './apiBase.js';

// Machine token → human sentence. Tokens the UI should never surface (e.g.
// `unauthenticated`, which just means "show the sign-in form") map to null.
export const AUTH_MESSAGES = {
  email_invalid: 'That email address does not look right.',
  password_too_short: 'Passwords need at least 10 characters.',
  password_too_long: 'That password is too long (200 characters max).',
  password_required: 'Enter a password.',
  email_in_use: 'That email already has an account — sign in instead.',
  invalid_credentials: 'Wrong email or password.',
  rate_limited: 'Too many attempts — give it a minute and try again.',
  rate_limiter_unavailable: 'The sign-in service is briefly unavailable — try again shortly.',
  origin_not_allowed: 'This page is not allowed to sign in — open the studio directly.',
  signup_failed: 'Could not create the account — try again.',
  network: 'Could not reach the server — check your connection and try again.',
  unauthenticated: null,
};

export function authMessage(errorToken) {
  // Key-presence, not nullish-coalescing: a token deliberately mapped to
  // null (silent) must STAY silent — `null ?? fallback` would give it words.
  if (errorToken in AUTH_MESSAGES) return AUTH_MESSAGES[errorToken];
  return 'Something went wrong — try again.';
}

/**
 * @param {{ apiBase?: string, fetchImpl?: typeof fetch }} [deps]
 */
export function createAuthClient({ apiBase = API_BASE, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  const call = async (path, /** @type {{ method?: string, body?: any }} */ { method = 'GET', body } = {}) => {
    let res;
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { ok: false, error: 'network', message: authMessage('network') };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const error = data?.error ?? 'network';
      return { ok: false, error, message: authMessage(error) };
    }
    return data;
  };

  return {
    signUp: ({ email, password, displayName }) =>
      call('/api/auth/signup', { method: 'POST', body: { email, password, displayName } }),
    signIn: ({ email, password }) =>
      call('/api/auth/signin', { method: 'POST', body: { email, password } }),
    signOut: () => call('/api/auth/signout', { method: 'POST', body: {} }),
    me: () => call('/api/auth/me'),
    /** Partial by design — send only what changed; the server COALESCEs.
     * @param {{ voiceId?: string, voiceName?: string, stylePrompt?: string, videoPathMs?: number }} [fields] */
    saveProfile: ({ voiceId, voiceName, stylePrompt, videoPathMs } = {}) =>
      call('/api/me/profile', {
        method: 'PUT',
        body: { voiceId, voiceName, stylePrompt, videoPathMs },
      }),
  };
}
