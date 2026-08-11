// The voice healer (CEO architecture, 10 Aug 2026): "the system does the
// work, not the user." A clone whose creating key has LEFT the pool (the
// operator's explicit dead-account signal) is re-provisioned from OUR
// stored sample on the first working key, silently — the user's voice
// follows them across vendor accounts, and ElevenLabs stays an
// interchangeable backend.
//
// The mechanics: the sample persisted at clone time lives in the AVATARS
// bucket under voice-samples/<userId>/<rowId> (structural isolation, same
// rule as avatars). Healing updates the SAME row (new vendor_voice_id +
// vendor_account) so the user's library, cap accounting, and sample keep
// one identity; if the profile's saved selection pointed at the old vendor
// id, it is remapped so the selection follows. The dead account's
// vendor-side voice cannot be deleted (no key) — it is logged as
// VOICE-STRANDED for reconciliation.
//
// Triggers (wired in index.js / voiceRoutes.js):
//   * session-create heals the user's SELECTED voice synchronously before
//     the policy stamp — the stream proceeds with their true voice;
//   * GET /api/me/voices heals every orphaned row — the library
//     self-repairs on view.
//
// Concurrency note (deliberate v1): two simultaneous heals of one row can
// double-clone; the second write wins and the stranded duplicate is
// logged. A per-user lock rides P5's wallet DO if the logs ever show it.

import { isPaymentRefusal, parsePool } from './vendorKeys.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';

export function sampleKey(userId, rowId) {
  return `voice-samples/${userId}/${rowId}`;
}

/** Is this row's creating key still in the pool? */
export function isOrphan(row, pool) {
  return !pool.some((c) => c.fingerprint === row.vendor_account);
}

/**
 * Clone `bytes` on the first key in the pool that accepts it; payment-class
 * refusals fall through to the next key, anything else stops (deterministic
 * rejections must not double-spend). Returns { voiceId, fingerprint } or
 * null. Shared by the clone route and the healer so there is ONE definition
 * of "the active account took it".
 */
export async function cloneOnPool(env, pool, { bytes, mimeType, vendorName, language }) {
  const base = env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE;
  for (const cand of pool) {
    const form = new FormData();
    form.set('name', vendorName);
    if (language) form.set('labels', JSON.stringify({ language }));
    form.append('files', new Blob([bytes], { type: mimeType || 'audio/mpeg' }), 'sample');
    let res;
    try {
      res = await fetch(`${base}/v1/voices/add`, {
        method: 'POST',
        headers: { 'xi-api-key': cand.key },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Unreachable vendor: not a key problem — trying the next key would
      // hit the same network. Stop.
      console.error('voice clone unreachable:', err);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (res.ok && data?.voice_id) {
      return { voiceId: data.voice_id, fingerprint: cand.fingerprint, key: cand.key };
    }
    if (isPaymentRefusal(res.status, data)) {
      console.error(`voice clone refused for MONEY on account ${cand.fingerprint} (HTTP ${res.status}) — trying next key`);
      continue;
    }
    console.error('voice clone refused:', res.status, data?.detail ?? '');
    return null;
  }
  return null;
}

/**
 * Heal one row if it needs it. Never throws; returns the (possibly updated)
 * row — callers keep working with whatever is true. No-ops: fingerprint
 * still in the pool; no stored sample (unhealable — e.g. the 'legacy'
 * sentinel); empty pool.
 */
export async function healUserVoice(env, db, userId, row) {
  try {
    const pool = await parsePool(env.ELEVENLABS_API_KEY);
    if (pool.length === 0 || !env.AVATARS || !isOrphan(row, pool)) return row;
    const sample = await env.AVATARS.get(sampleKey(userId, row.id));
    if (!sample) return row; // no sample, no heal — dashboard-era voices stay put
    const bytes = new Uint8Array(await sample.arrayBuffer());
    const healed = await cloneOnPool(env, pool, {
      bytes,
      mimeType: sample.httpMetadata?.contentType,
      vendorName: `lumina-${userId.slice(0, 8)}-${row.label}`.slice(0, 90),
    });
    if (!healed) return row;
    // Compare-and-swap: only the FIRST heal of this row wins; a concurrent
    // loser deletes its duplicate clone with the key that made it and
    // adopts whatever the winner wrote.
    const won = await db.updateUserVoiceVendorIf(userId, row.id, {
      expectedVendorVoiceId: row.vendor_voice_id,
      vendorVoiceId: healed.voiceId,
      vendorAccount: healed.fingerprint,
    });
    if (!won) {
      try {
        const del = await fetch(`${env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE}/v1/voices/${encodeURIComponent(healed.voiceId)}`, {
          method: 'DELETE',
          headers: { 'xi-api-key': healed.key },
          signal: AbortSignal.timeout(15_000),
        });
        // An HTTP failure RESOLVES — it is a failed compensation, not a
        // success (the PR-94 lesson, applied here too). 404 = already gone.
        if (!del.ok && del.status !== 404) {
          console.error(`VOICE-ORPHAN ${healed.voiceId}: losing duplicate heal delete answered ${del.status}`);
        }
      } catch (err) {
        console.error(`VOICE-ORPHAN ${healed.voiceId}: losing duplicate heal could not be deleted`, err);
      }
      return (await db.findUserVoice(userId, row.id)) ?? row;
    }
    await db.remapProfileVoiceId(userId, row.vendor_voice_id, healed.voiceId);
    console.error(
      `VOICE-STRANDED ${row.vendor_account} ${row.vendor_voice_id}: healed to ${healed.fingerprint} ${healed.voiceId} — the old vendor-side voice has no key to delete it with`,
    );
    return { ...row, vendor_voice_id: healed.voiceId, vendor_account: healed.fingerprint };
  } catch (err) {
    // Healing is a repair, never a new failure mode: the caller proceeds
    // with the unhealed row and the next trigger retries.
    console.error('voice heal failed, continuing unhealed:', err);
    return row;
  }
}
