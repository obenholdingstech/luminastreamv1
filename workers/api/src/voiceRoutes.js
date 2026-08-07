// P4c — per-user voices (CEO isolation mandate, 7 Aug 2026). Every query is
// scoped by the resolved session's userId — no endpoint here has a parameter
// that could name anyone else.
//
// P4c-3 adds the WRITE side: clone creation (ElevenLabs IVC) and deletion.
// Both FAIL CLOSED until ELEVENLABS_API_KEY exists on the Worker — that is a
// spend-authority key, one of the three human walls, and its placement is
// the CEO's act alone. Until then every clone call answers 503
// voice_vendor_unconfigured, which is the wall working, not an outage.

// CEO mandate, 8 Aug 2026: five custom voices per user, enforced by the
// same atomic slot logic as the avatar cap — the count guard lives IN the
// insert (db.addUserVoice), so concurrent clones cannot race past it and
// spam the vendor's cloning endpoint. (The pre-vendor listUserVoices check
// in clone() is only the cheap early refusal; the insert is the wall.)
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
async function compensateVendorVoice(env, base, vendorVoiceId) {
  try {
    const res = await fetch(`${base}/v1/voices/${encodeURIComponent(vendorVoiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
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
    /** GET /api/me/voices — the caller's clones, nothing else's. */
    async list(request, env, origin) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const voices = await session.db.listUserVoices(session.userId);
      return json(
        {
          ok: true,
          voices: voices.map((v) => ({ id: v.id, voiceId: v.vendor_voice_id, label: v.label })),
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
      if (!env.ELEVENLABS_API_KEY) {
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

      // Vendor-attributable name: the ElevenLabs dashboard must say whose
      // clone this is without a database lookup.
      const vendorName = `lumina-${session.userId.slice(0, 8)}-${label}`.slice(0, 90);
      const form = new FormData();
      form.set('name', vendorName);
      form.append('files', new Blob([bytes], { type: body?.mimeType || 'audio/mpeg' }), 'sample');
      let res;
      try {
        res = await fetch(`${env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE}/v1/voices/add`, {
          method: 'POST',
          headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.voice_id) {
        // Log the detail, never echo it — vendor errors can carry account
        // internals a client has no business reading.
        console.error('voice clone refused:', res.status, data?.detail ?? '');
        return json({ ok: false, error: 'voice_clone_rejected' }, { status: 502, origin });
      }
      // The atomic cap: count-and-insert in one statement, because the
      // listUserVoices check above is only the CHEAP early refusal — two
      // concurrent clones can both pass it (CodeRabbit, PR 94). From here
      // on the vendor voice EXISTS, so every failure — the cap refusing,
      // or the database throwing outright — must compensate at the vendor
      // before answering: an unregistered clone spends quota and belongs
      // to no one.
      const vendorBase = env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE;
      let registered;
      try {
        registered = await session.db.addUserVoice(session.userId, {
          vendorVoiceId: data.voice_id,
          label,
          cap: MAX_VOICES_PER_USER,
        });
      } catch (err) {
        console.error('clone registration failed after vendor create:', err);
        await compensateVendorVoice(env, vendorBase, data.voice_id);
        return json({ ok: false, error: 'voice_clone_rejected' }, { status: 502, origin });
      }
      if (!registered) {
        await compensateVendorVoice(env, vendorBase, data.voice_id);
        return json({ ok: false, error: 'voice_limit_reached' }, { status: 409, origin });
      }
      return json({ ok: true, id: registered.id, voiceId: data.voice_id, label }, { origin });
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
      if (!env.ELEVENLABS_API_KEY) {
        return json({ ok: false, error: 'voice_vendor_unconfigured' }, { status: 503, origin });
      }
      let vres;
      try {
        vres = await fetch(
          `${env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE}/v1/voices/${encodeURIComponent(row.vendor_voice_id)}`,
          {
            method: 'DELETE',
            headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        return json({ ok: false, error: 'vendor_unreachable' }, { status: 502, origin });
      }
      if (!vres.ok && vres.status !== 404) {
        return json({ ok: false, error: 'vendor_delete_failed' }, { status: 502, origin });
      }
      await session.db.removeUserVoice(session.userId, rowId);
      return json({ ok: true }, { origin });
    },
  };
}
