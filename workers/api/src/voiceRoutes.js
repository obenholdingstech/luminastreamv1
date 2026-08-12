// P4c — per-user voices (CEO isolation mandate, 7 Aug 2026). Every query is
// scoped by the resolved session's userId — no endpoint here has a parameter
// that could name anyone else.
//
// P4c-3 adds the WRITE side: clone creation (ElevenLabs IVC) and deletion.
// Both FAIL CLOSED until ELEVENLABS_API_KEY exists on the Worker — that is a
// spend-authority key, one of the three human walls, and its placement is
// the CEO's act alone. Until then every clone call answers 503
// voice_vendor_unconfigured, which is the wall working, not an outage.

// CEO mandate, 7 Aug 2026, late: five custom voices per user, enforced by the
// same atomic slot logic as the avatar cap — the count guard lives IN the
// insert (db.addUserVoice), so concurrent clones cannot race past it and
// spam the vendor's cloning endpoint. (The pre-vendor listUserVoices check
// in clone() is only the cheap early refusal; the insert is the wall.)
import { parsePool } from './vendorKeys.js';
import { cloneOnPool, healUserVoice, sampleKey } from './voiceHeal.js';

export const MAX_VOICES_PER_USER = 5;
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
// ~10MB decoded — a voice sample is audio (the vendor wants ≥1 minute of
// clean speech), so the ceiling is higher than the avatar wall. Base64
// inflates 4/3.
const MAX_SAMPLE_B64_CHARS = 14_000_000;

/** Decode a data-URL or bare-base64 audio sample, or null. Same posture as
 * the avatar path: atob is stricter than the regex, and a malformed upload
 * must be a 400, never a 500. */
function decodeSample(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const b64 = raw.startsWith('data:') ? (raw.split(',', 2)[1] ?? '') : raw;
  if (!b64 || b64.length > MAX_SAMPLE_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) return null;
  try {
    const binary = atob(b64.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Compensating delete for a vendor voice that must not survive (its
 * registration failed). Never throws; returns whether the vendor no longer
 * has it. Every failure path emits ONE structured, greppable line —
 * `VOICE-ORPHAN <id>` — because an unregistered clone spends quota and
 * belongs to no one, and the vendor dashboard shows the attributable
 * `lumina-<user>` name for a human to reap. (A durable retry queue is the
 * ledger-executioner pattern; it arrives if orphan lines ever actually
 * appear — the alert comes first, the machinery only with evidence.)
 */
async function compensateVendorVoice(apiKey, base, vendorVoiceId) {
  try {
    const res = await fetch(`${base}/v1/voices/${encodeURIComponent(vendorVoiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    // An HTTP failure RESOLVES (ok === false) — it must count as a failed
    // compensation, not a success (CodeRabbit, PR 94). 404 = already gone.
    if (res.ok || res.status === 404) return true;
    console.error(`VOICE-ORPHAN ${vendorVoiceId}: vendor delete answered ${res.status}`);
    return false;
  } catch (err) {
    console.error(`VOICE-ORPHAN ${vendorVoiceId}: vendor delete unreachable`, err);
    return false;
  }
}

/**
 * @param {object} kit — { json, readJson, clientIp, checkRateLimit,
 *   rateLimitRefusal, createDb, resolveUserSession, mayStartSession }
 */
export function createVoiceRoutes(kit) {
  const {
    json,
    readJson,
    clientIp,
    checkRateLimit,
    rateLimitRefusal,
    createDb,
    resolveUserSession,
    mayStartSession,
    corsHeaders,
  } = kit;

  // Rate-limit BEFORE auth, like every other route family. MEDIA_LIMITER
  // once the avatar-vault PR lands its binding; TOKEN_LIMITER carries the
  // duty until then so this module needs no config of its own.
  async function requireUser(request, env, origin) {
    const limited = rateLimitRefusal(
      await checkRateLimit(env.MEDIA_LIMITER ?? env.TOKEN_LIMITER, `voices:${clientIp(request)}`),
      origin,
    );
    if (limited) return { refusal: limited };
    const session = await resolveUserSession(request, env, createDb);
    if (!session) {
      return { refusal: json({ ok: false, error: 'unauthenticated' }, { status: 401, origin }) };
    }
    return { session };
  }

  return {
    /**
     * GET /api/me/voices/:id/sample — the caller's OWN vaulted reference
     * audio, streamed for the card's preview button. The sample is
     * personal data: only the owning session reaches it (findUserVoice is
     * scoped by userId), and a row without a vaulted object — a
     * dashboard-era clone — is a plain 404, not an error. Private
     * cache only: this must never land in a shared cache.
     */
    async sample(request, env, origin, rowId) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const row = await session.db.findUserVoice(session.userId, rowId);
      if (!row) return json({ ok: false, error: 'voice_not_found' }, { status: 404, origin });
      if (!env.AVATARS) {
        return json({ ok: false, error: 'voice_storage_unavailable' }, { status: 503, origin });
      }
      const obj = await env.AVATARS.get(sampleKey(session.userId, row.id));
      if (!obj) return json({ ok: false, error: 'sample_not_found' }, { status: 404, origin });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType ?? 'audio/wav',
          'Cache-Control': 'private, max-age=300',
          ...corsHeaders(origin),
        },
      });
    },

    /** GET /api/me/voices — the caller's clones, nothing else's. */
    async list(request, env, origin) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const rows = await session.db.listUserVoices(session.userId);
      // The library self-repairs on view: any clone whose creating key left
      // the pool is re-provisioned from OUR sample (healUserVoice no-ops
      // for healthy rows and never throws — the list is not the place a
      // repair becomes a failure).
      const voices = [];
      for (const row of rows) {
        voices.push(await healUserVoice(env, session.db, session.userId, row));
      }
      return json(
        {
          ok: true,
          voices: voices.map((v) => ({
            id: v.id,
            voiceId: v.vendor_voice_id,
            label: v.label,
            vendorAccount: v.vendor_account,
            // The conditioning language chosen at clone time (0007) — the
            // studio renders it as the card's language tag. Null for
            // auto-detect; never fabricated.
            language: v.language ?? null,
          })),
        },
        { origin },
      );
    },

    /**
     * POST /api/me/voices — clone from a sample. Order of walls: limiter →
     * session → verification (cloning SPENDS vendor quota — same wall as
     * starting a session) → vendor key (fail closed) → per-user cap →
     * sample validity. Nothing reaches the vendor until every wall passes.
     */
    async clone(request, env, origin) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      if (!mayStartSession(session)) {
        return json({ ok: false, error: 'verification_required' }, { status: 403, origin });
      }
      const pool = await parsePool(env.ELEVENLABS_API_KEY);
      if (pool.length === 0) {
        return json({ ok: false, error: 'voice_vendor_unconfigured' }, { status: 503, origin });
      }
      // The sample vault is REQUIRED: a clone we cannot heal later must not
      // exist (CEO architecture — the voice is OUR property, the vendor is
      // interchangeable).
      if (!env.AVATARS) {
        return json({ ok: false, error: 'voice_vendor_unconfigured' }, { status: 503, origin });
      }
      const existing = await session.db.listUserVoices(session.userId);
      if (existing.length >= MAX_VOICES_PER_USER) {
        return json({ ok: false, error: 'voice_limit_reached' }, { status: 409, origin });
      }
      const body = await readJson(request);
      const bytes = decodeSample(body?.sampleData);
      if (!bytes) return json({ ok: false, error: 'sample_invalid' }, { status: 400, origin });
      const label =
        typeof body?.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 60)
          : 'My voice';
      const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'audio/mpeg';
      // Language/accent (clone modal, 11 Aug 2026): optional, validated,
      // and forwarded to the vendor as voice labels — vendor-side metadata
      // that improves clone conditioning and shows in the dashboard.
      let language;
      if (body?.language !== undefined && body?.language !== '') {
        if (typeof body.language !== 'string' || !/^[a-z]{2}(-[a-zA-Z]{2,8})?$/.test(body.language)) {
          return json({ ok: false, error: 'language_invalid' }, { status: 400, origin });
        }
        language = body.language;
      }

      // The row id is minted BEFORE the vendor call so the stored sample and
      // the row share one identity from birth; the sample lands FIRST —
      // personal data whose retention serves the user (it dies with the
      // voice, and P8 account-deletion will cascade here).
      const rowId = crypto.randomUUID();
      const skey = sampleKey(session.userId, rowId);
      try {
        await env.AVATARS.put(skey, bytes, { httpMetadata: { contentType: mimeType } });
      } catch (err) {
        console.error('voice sample failed to land, refusing the clone:', err);
        return json({ ok: false, error: 'storage_unavailable' }, { status: 502, origin });
      }

      // Vendor-attributable name: the ElevenLabs dashboard must say whose
      // clone this is without a database lookup. cloneOnPool tries keys in
      // pool order, falling through payment-class refusals only.
      const created = await cloneOnPool(env, pool, {
        bytes,
        mimeType,
        vendorName: `lumina-${session.userId.slice(0, 8)}-${label}`.slice(0, 90),
        language,
      });
      if (!created) {
        await env.AVATARS.delete(skey).catch((err) =>
          console.error(`SAMPLE-ORPHAN ${skey}: cleanup after clone refusal failed`, err),
        );
        return json({ ok: false, error: 'voice_clone_rejected' }, { status: 502, origin });
      }
      // The atomic cap: count-and-insert in one statement (PR 94). From here
      // on the vendor voice EXISTS, so every failure compensates at the
      // vendor — with the CREATING key — and reaps the sample.
      const vendorBase = env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE;
      let registered;
      try {
        registered = await session.db.addUserVoice(session.userId, {
          id: rowId,
          vendorVoiceId: created.voiceId,
          label,
          cap: MAX_VOICES_PER_USER,
          vendorAccount: created.fingerprint,
          language: language ?? null,
        });
      } catch (err) {
        console.error('clone registration failed after vendor create:', err);
        await compensateVendorVoice(created.key, vendorBase, created.voiceId);
        await env.AVATARS.delete(skey).catch((err) =>
          console.error(`SAMPLE-ORPHAN ${skey}: cleanup after registration failure failed`, err),
        );
        return json({ ok: false, error: 'voice_clone_rejected' }, { status: 502, origin });
      }
      if (!registered) {
        await compensateVendorVoice(created.key, vendorBase, created.voiceId);
        await env.AVATARS.delete(skey).catch((err) =>
          console.error(`SAMPLE-ORPHAN ${skey}: cleanup after cap refusal failed`, err),
        );
        return json({ ok: false, error: 'voice_limit_reached' }, { status: 409, origin });
      }
      return json(
        { ok: true, id: registered.id, voiceId: created.voiceId, label, vendorAccount: created.fingerprint },
        { origin },
      );
    },

    /**
     * DELETE /api/me/voices/:rowId — vendor first, row second: a clone that
     * still exists at the vendor must stay attributed to its owner, so the
     * row only dies once the vendor confirms (404 = already gone, fine to
     * reap). The lookup is scoped by BOTH id and user_id — someone else's
     * row id is a 404 before any vendor call.
     */
    async remove(request, env, origin, rowId) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const row = await session.db.findUserVoice(session.userId, rowId);
      if (!row) return json({ ok: false, error: 'voice_not_found' }, { status: 404, origin });
      const pool = await parsePool(env.ELEVENLABS_API_KEY);
      if (pool.length === 0) {
        return json({ ok: false, error: 'voice_vendor_unconfigured' }, { status: 503, origin });
      }
      // The vendor delete needs the CREATING account's key. Absent from the
      // pool → HARD refusal: soft-skipping would manufacture the exact
      // VOICE-ORPHAN condition this module exists to prevent, and naming
      // the missing account is an operator problem to surface, not hide.
      const creating = pool.find((c) => c.fingerprint === row.vendor_account);
      if (!creating) {
        return json({ ok: false, error: 'voice_vendor_account_unavailable' }, { status: 503, origin });
      }
      let vres;
      try {
        vres = await fetch(
          `${env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE}/v1/voices/${encodeURIComponent(row.vendor_voice_id)}`,
          {
            method: 'DELETE',
            headers: { 'xi-api-key': creating.key },
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
      }
      if (!vres.ok && vres.status !== 404) {
        return json({ ok: false, error: 'vendor_delete_failed' }, { status: 502, origin });
      }
      // The sample dies BEFORE the row (CodeRabbit, PR 104): if this delete
      // fails, the row survives and the user's retry re-runs the whole
      // chain idempotently (the vendor delete above tolerates 404), so the
      // cleanup obligation is never silently lost — no new state needed,
      // the ROW is the retry record.
      if (env.AVATARS) {
        try {
          await env.AVATARS.delete(sampleKey(session.userId, rowId));
        } catch (err) {
          console.error(`SAMPLE-ORPHAN ${sampleKey(session.userId, rowId)}: delete failed, row kept for retry`, err);
          return json({ ok: false, error: 'sample_cleanup_failed' }, { status: 502, origin });
        }
      }
      await session.db.removeUserVoice(session.userId, rowId);
      return json({ ok: true }, { origin });
    },
  };
}
