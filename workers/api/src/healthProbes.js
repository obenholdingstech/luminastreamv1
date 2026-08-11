// System-health probes (CEO mandate, 11 Aug 2026): "if a stream fails, I
// need to … instantly pinpoint whether it is a dead key or a crashed server
// unit, without ever having to SSH."
//
// Two families:
//   * VENDOR KEY probes — one live, zero-spend request per pool key.
//     ElevenLabs: GET /v1/user/subscription (free; also yields quota, the
//     early warning BEFORE a key dies). Decart: a minimal client-token mint
//     (mints are free; the 422 "Insufficient credits" broke-signal surfaces
//     exactly here).
//   * AGENT liveness — the room truth via LiveKit's server API: an agent is
//     LIVE in a room iff an `echo-*` participant is present. This measures
//     what users experience (agent presence), not a process's opinion of
//     itself, and needs no SSH and no new credentials.
//
// Every probe: own timeout, never throws — a dead vendor yields a row that
// SAYS dead, not a blank screen. Statuses: ok | payment | rejected |
// unreachable. Keys appear only as fingerprints.

import { isDecartPaymentRefusal, parsePool } from './vendorKeys.js';
import { mintLiveKitToken } from './livekit.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const DECART_API_BASE = 'https://api.decart.ai';
const PROBE_TIMEOUT_MS = 8_000;

async function probeElevenLabsKey(env, cand) {
  const row = { vendor: 'elevenlabs', fingerprint: cand.fingerprint };
  try {
    const res = await fetch(`${env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE}/v1/user/subscription`, {
      headers: { 'xi-api-key': cand.key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ...row, status: 'rejected', detail: `key rejected (HTTP ${res.status})` };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ...row, status: 'payment', detail: `subscription endpoint answered HTTP ${res.status}` };
    }
    const subStatus = body?.status ?? 'unknown';
    const used = body?.character_count;
    const limit = body?.character_limit;
    const quota =
      Number.isFinite(used) && Number.isFinite(limit) && limit > 0
        ? { used, limit }
        : null;
    // The vendor's own subscription vocabulary: anything not plainly active
    // is a payment-class warning the CEO should see amber, not green.
    const healthy = ['active', 'trialing', 'free'].includes(String(subStatus).toLowerCase());
    return {
      ...row,
      status: healthy ? 'ok' : 'payment',
      detail: `subscription ${subStatus}`,
      quota,
    };
  } catch {
    return { ...row, status: 'unreachable', detail: 'no answer within the probe timeout' };
  }
}

async function probeDecartKey(env, cand) {
  const row = { vendor: 'decart', fingerprint: cand.fingerprint };
  try {
    const res = await fetch(`${env.DECART_API_BASE ?? DECART_API_BASE}/v1/client/tokens`, {
      method: 'POST',
      headers: { 'x-api-key': cand.key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        expiresIn: 60,
        constraints: { realtime: { maxSessionDuration: 1 } },
        metadata: { probe: 'admin-health' },
      }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.apiKey) return { ...row, status: 'ok', detail: 'token mint accepted' };
    if (isDecartPaymentRefusal(res.status, body)) {
      return { ...row, status: 'payment', detail: `money refusal (HTTP ${res.status})` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ...row, status: 'rejected', detail: `key rejected (HTTP ${res.status})` };
    }
    return { ...row, status: 'unreachable', detail: `unexpected HTTP ${res.status}` };
  } catch {
    return { ...row, status: 'unreachable', detail: 'no answer within the probe timeout' };
  }
}

/** Every pool key of every vendor, probed live in parallel. */
export async function probeVendorKeys(env) {
  const [eleven, decart] = await Promise.all([
    parsePool(env.ELEVENLABS_API_KEY),
    parsePool(env.DECART_API_KEY),
  ]);
  const rows = await Promise.all([
    ...eleven.map((c) => probeElevenLabsKey(env, c)),
    ...decart.map((c) => probeDecartKey(env, c)),
  ]);
  return rows;
}

/**
 * Agent liveness per pool room, via LiveKit's RoomService. A missing
 * LiveKit config yields rows that say 'unknown' rather than an error —
 * the screen renders what it can.
 */
export async function probeAgents(env) {
  const rooms = String(env.SESSION_ROOMS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (rooms.length === 0) return [];
  const host = String(env.LIVEKIT_URL ?? '').replace(/^wss?:\/\//, '');
  if (!host || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return rooms.map((room) => ({ room, agentLive: null, participants: null, detail: 'livekit not configured' }));
  }
  return Promise.all(
    rooms.map(async (room) => {
      try {
        const { token } = await mintLiveKitToken(env, {
          room,
          identity: 'admin-health-probe',
          ttlSeconds: 60,
          // RoomService requires the admin grant for the room it inspects.
          video: { roomAdmin: true, room },
        });
        const res = await fetch(`https://${host}/twirp/livekit.RoomService/ListParticipants`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          body: JSON.stringify({ room }),
        });
        if (!res.ok) {
          return { room, agentLive: null, participants: null, detail: `livekit answered HTTP ${res.status}` };
        }
        const body = await res.json().catch(() => null);
        const participants = body?.participants ?? [];
        const agent = participants.find((p) => String(p?.identity ?? '').startsWith('echo-'));
        return {
          room,
          agentLive: Boolean(agent),
          agentIdentity: agent?.identity ?? null,
          participants: participants.length,
        };
      } catch {
        return { room, agentLive: null, participants: null, detail: 'no answer within the probe timeout' };
      }
    }),
  );
}
