// The Health view's behavior, as a pure module (CodeRabbit, PR 107 — the
// house rule, applied at review again): status vocabulary, quota
// formatting, timestamps, and the refresh cadence live here with tests;
// the component keeps React lifecycle and rendering.

export const HEALTH_REFRESH_MS = 30_000;

const PILLS = {
  ok: { tone: 'text-[#34D399]', word: 'ok' },
  payment: { tone: 'text-[#FBBF24]', word: 'payment issue' },
  rejected: { tone: 'text-[#FCA5A5]', word: 'key rejected' },
  unreachable: { tone: 'text-[#64748B]', word: 'unreachable' },
};

/** Status → { tone, word }; unknown statuses render as themselves, grey. */
export function statusPill(status) {
  return PILLS[status] ?? { tone: 'text-[#64748B]', word: String(status) };
}

/** Quota → { percent, text } for the bar + label, or null when absent. */
export function formatQuota(quota) {
  if (!quota || !Number.isFinite(quota.used) || !Number.isFinite(quota.limit) || quota.limit <= 0) {
    return null;
  }
  const percent = Math.min(100, Math.max(0, Math.round((quota.used / quota.limit) * 100)));
  return { percent, text: `${percent}% of ${quota.limit.toLocaleString()}` };
}

/** Epoch millis → 'YYYY-MM-DD HH:MM:SS' UTC, or null for junk. */
export function formatCheckedAt(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  // Finite-but-beyond-Date-range (>8.64e15) would make toISOString THROW —
  // fail-soft means null, never a RangeError in a render.
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/** The agent cell's verdict: 'live' | 'down' | 'unknown' + its prose. */
export function agentVerdict(row) {
  if (row?.agentLive === true) {
    return { state: 'live', text: row.agentIdentity ? `live — ${row.agentIdentity}` : 'live' };
  }
  if (row?.agentLive === false) return { state: 'down', text: 'not serving' };
  return { state: 'unknown', text: 'unknown' };
}
