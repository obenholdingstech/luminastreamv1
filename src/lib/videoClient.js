// Client for the white-label video session (workers/api, /api/video/session*).
//
// The browser never talks to Decart's control plane — every call here goes to
// our Worker, which holds the vendor key and performs the vendor calls itself
// (ROADMAP §P2, the committed topology). What the browser does own is the
// MEDIA: the RTCPeerConnection is peer-to-peer with Decart, so lip-sync pays
// no proxy tax.
//
// Two credentials, two jobs:
//   X-Admin-Token   the dev-stage gate (retires at P4)
//   controlToken    session-scoped, returned by create, required by every
//                   control call. A token for one session opens no other.
//
// Nothing here reports usage. Settlement is vendor-truth: the Worker deletes
// at Decart and reads the billing summary from its own exchange. A client
// that could report its own bill would report a small one.

import { API_BASE } from './apiBase.js';
import { DEFAULT_TIMEOUT_MS, deadline, postJson, asTimeoutError } from './apiFetch.js';

export { DEFAULT_TIMEOUT_MS };

/** @param {string} message @param {{status?: number, code?: string}} [meta] */
function videoError(message, { status, code } = {}) {
  const err = /** @type {Error & {status?: number, code?: string}} */ (new Error(message));
  if (status !== undefined) err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

function describeRefusal(status, data) {
  const code = data?.error;
  if (code === 'video_budget_exhausted') {
    return videoError('the video budget is spent — no new sessions until it is topped up', {
      status,
      code,
    });
  }
  if (code === 'video_disabled') {
    return videoError('video is switched off for this deployment', { status, code });
  }
  if (code === 'video_vendor_unconfigured') {
    return videoError('video is not configured on the server', { status, code });
  }
  if (code === 'at_capacity') {
    return videoError('the lens is busy right now — try again in a moment', { status, code });
  }
  if (status === 401) return videoError('admin session expired', { status, code });
  if (status === 429) {
    return videoError('too many attempts — wait a minute and retry', { status, code });
  }
  // Prose, never the raw code — the lesson from sessionClient, applied here
  // before it could be learned twice.
  return videoError(`could not start video (HTTP ${status})`, { status, code });
}

/**
 * Open a white-label session. The Worker reserves budget, mints a constrained
 * vendor token for its own use, creates the Decart session, binds it to the
 * reservation, and only then answers — so by the time this resolves, the
 * session already has a server-side owner that can kill it.
 *
 * @param {string} adminToken
 * @param {{ sdpOffer: string, requestedSeconds?: number, prompt?: string }} args
 * @param {string} [base]
 * @param {AbortSignal|null} [signal]
 */
export async function createVideoSession(adminToken, args, base = API_BASE, signal = deadline()) {
  if (!base) throw videoError('server API not configured (VITE_API_BASE unset)');
  if (!args?.sdpOffer) throw videoError('an SDP offer is required');
  let status;
  let data;
  try {
    ({ status, data } = await postJson(`${base}/api/video/session`, {
      adminToken,
      signal,
      body: {
        sdpOffer: args.sdpOffer,
        ...(args.requestedSeconds ? { requestedSeconds: args.requestedSeconds } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
      },
    }));
  } catch (err) {
    throw asTimeoutError(err);
  }
  if (status === 200 && data?.ok && data.sessionId && data.controlToken) {
    return {
      sessionId: data.sessionId,
      controlToken: data.controlToken,
      grantedSeconds: data.grantedSeconds,
      remainingSeconds: data.remainingSeconds,
      vendor: data.vendor ?? {},
    };
  }
  throw describeRefusal(status, data);
}

/**
 * Forward ICE candidates. Never throws — a lost candidate degrades
 * connectivity, it does not warrant tearing down a working negotiation, and
 * WebRTC retries by design.
 */
export async function sendCandidates(adminToken, session, candidates, base = API_BASE) {
  if (!base || !session?.sessionId) return false;
  try {
    const { status } = await postJson(
      `${base}/api/video/session/${encodeURIComponent(session.sessionId)}/candidates`,
      {
        adminToken,
        signal: deadline(),
        body: { controlToken: session.controlToken, candidates, etag: session.etag ?? undefined },
      },
    );
    return status === 200;
  } catch {
    return false;
  }
}

/** Update the transformation prompt mid-session. Returns false on refusal. */
export async function setVideoPrompt(adminToken, session, prompt, base = API_BASE) {
  if (!base || !session?.sessionId) return false;
  try {
    const { status } = await postJson(
      `${base}/api/video/session/${encodeURIComponent(session.sessionId)}/prompt`,
      { adminToken, signal: deadline(), body: { controlToken: session.controlToken, prompt } },
    );
    return status === 200;
  } catch {
    return false;
  }
}

/**
 * End the session. The Worker performs the vendor DELETE and settles from
 * Decart's own billing summary.
 *
 * Returns `{ ok, settled?, usedSeconds?, deferred? }`. **`deferred: true` is
 * not a failure to hide**: it means the vendor delete failed and the server
 * kept the reservation so its executioner alarm can retry. The UI says the
 * session is closing rather than claiming it closed — the one case where
 * "stop" is not instantly true, and pretending otherwise would be the silent
 * freeze the canon forbids.
 */
export async function endVideoSession(adminToken, session, base = API_BASE) {
  if (!base || !session?.sessionId) return { ok: false };
  try {
    const { status, data } = await postJson(
      `${base}/api/video/session/${encodeURIComponent(session.sessionId)}/end`,
      { adminToken, signal: deadline(), body: { controlToken: session.controlToken } },
    );
    if (status === 200 && data?.ok) {
      return { ok: true, settled: data.settled === true, usedSeconds: data.usedSeconds };
    }
    if (data?.error === 'vendor_delete_failed') {
      return { ok: false, deferred: true, code: data.error };
    }
    return { ok: false, code: data?.error };
  } catch {
    return { ok: false };
  }
}

/** Read the video budget. Admin-gated; the lens shows it as remaining time. */
export async function readVideoBudget(adminToken, base = API_BASE) {
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/video/budget`, {
      headers: { 'X-Admin-Token': adminToken },
      signal: deadline(),
    });
    const data = await res.json().catch(() => null);
    return res.ok && data?.ok ? data : null;
  } catch {
    return null;
  }
}

/**
 * Is this SDK/vendor error the TERMINAL duration limit?
 *
 * The probe (3 Aug 2026) measured what happens at the constraint: Decart stops
 * generating, emits "Session duration limit reached", and the SDK then
 * AUTO-RECONNECTS into a connected-but-not-generating zombie. That zombie is
 * exactly the silent freeze the canon forbids a user ever seeing — so this
 * error is terminal, the reconnect is ignored, and the UI stops with a
 * visible reason.
 */
export function isDurationLimitError(err) {
  const message = typeof err === 'string' ? err : (err?.message ?? '');
  return /session duration limit|duration limit reached/i.test(message);
}
