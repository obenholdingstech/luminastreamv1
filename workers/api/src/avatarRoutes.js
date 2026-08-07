// P4c — the avatar library, isolated per user (CEO mandate, 7 Aug 2026:
// "database isolation is non-negotiable. An ordinary user must only be able
// to query and use the R2 avatars … attached to their specific user_id").
//
// The isolation is STRUCTURAL, not checked: every R2 key this module ever
// reads or writes is built as `avatars/<userId>/<avatarId>` where userId
// comes from the resolved cookie session — never from the request body, the
// path, or a query param. There is no code path in which one user's request
// can even EXPRESS another user's key, which is a stronger property than an
// ownership comparison that could be forgotten on the next endpoint.
//
// The profile's `avatar_key` records the SELECTED avatar (P4a reserved the
// column and kept it non-client-writable for exactly this moment); the
// library itself lives in R2 under the user's prefix and is listed by
// prefix, so there is no metadata table to drift out of sync with the
// objects.
//
// Size/type ride the SAME wall as the live path (normalizeReferenceImage's
// 5MB base64 ceiling), so an avatar the library accepts is an avatar a
// session can actually use.

export const MAX_AVATARS_PER_USER = 8;
const AVATAR_ID_RE = /^[0-9a-f]{32}$/;

/** The one place a key is ever assembled. */
function avatarKey(userId, avatarId) {
  return `avatars/${userId}/${avatarId}`;
}

function avatarPrefix(userId) {
  return `avatars/${userId}/`;
}

/**
 * Decode, or null. atob is stricter than normalizeReferenceImage's regex
 * (bad padding passes the regex but throws here), and a malformed upload
 * must be a 400, never a 500.
 */
function decodeB64(b64) {
  try {
    const binary = atob(b64.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** data URL → its mime, when it names one we accept; else a safe default. */
function imageContentType(raw) {
  const m = typeof raw === 'string' ? raw.match(/^data:(image\/(?:jpeg|png|webp));base64,/) : null;
  return m ? m[1] : 'image/jpeg';
}

/**
 * @param {object} kit — the index.js toolbox: { json, readJson, clientIp,
 *   checkRateLimit, rateLimitRefusal, createDb, resolveUserSession,
 *   normalizeReferenceImage, corsHeaders }
 */
export function createAvatarRoutes(kit) {
  const {
    json,
    readJson,
    clientIp,
    checkRateLimit,
    rateLimitRefusal,
    createDb,
    resolveUserSession,
    normalizeReferenceImage,
    corsHeaders,
  } = kit;

  // Every route: configured → rate-limited → authenticated, in that order.
  // The limiter runs BEFORE auth so an anonymous flood cannot buy D1 reads.
  async function requireUser(request, env, origin) {
    if (!env.AVATARS) {
      return { refusal: json({ ok: false, error: 'avatars_unconfigured' }, { status: 503, origin }) };
    }
    const limited = rateLimitRefusal(
      await checkRateLimit(env.MEDIA_LIMITER, `media:${clientIp(request)}`),
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
    /** GET /api/me/avatars — the caller's library, nothing else's. */
    async list(request, env, origin) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const prefix = avatarPrefix(session.userId);
      const listed = await env.AVATARS.list({ prefix });
      const profile = await session.db.getProfile(session.userId);
      const selectedKey = profile?.avatar_key ?? null;
      const avatars = listed.objects.map((o) => ({
        id: o.key.slice(prefix.length),
        name: o.customMetadata?.name ?? 'avatar',
        size: o.size,
        uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded ?? ''),
        selected: o.key === selectedKey,
      }));
      return json({ ok: true, avatars, max: MAX_AVATARS_PER_USER }, { origin });
    },

    /** POST /api/me/avatars — store one under the caller's prefix, select it. */
    async upload(request, env, origin) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      const body = await readJson(request);
      const b64 = normalizeReferenceImage(body?.imageData);
      if (!b64) return json({ ok: false, error: 'image_invalid' }, { status: 400, origin });
      const existing = await env.AVATARS.list({ prefix: avatarPrefix(session.userId) });
      if (existing.objects.length >= MAX_AVATARS_PER_USER) {
        return json({ ok: false, error: 'avatar_limit_reached' }, { status: 409, origin });
      }
      const bytes = decodeB64(b64);
      if (!bytes) return json({ ok: false, error: 'image_invalid' }, { status: 400, origin });
      const avatarId = crypto.randomUUID().replaceAll('-', '');
      const name =
        typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'avatar';
      const key = avatarKey(session.userId, avatarId);
      await env.AVATARS.put(key, bytes, {
        customMetadata: { name },
        httpMetadata: { contentType: imageContentType(body?.imageData) },
      });
      // Uploading selects: the newest identity is the one the user means.
      // (upsertProfile COALESCEs, so nothing else in the profile is touched.)
      await session.db.upsertProfile(session.userId, { avatarKey: key });
      return json({ ok: true, id: avatarId, name, selected: true }, { origin });
    },

    /** GET /api/me/avatars/:id — the bytes, for preview. Own prefix only. */
    async fetchOne(request, env, origin, avatarId) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      if (!AVATAR_ID_RE.test(avatarId)) {
        return json({ ok: false, error: 'avatar_not_found' }, { status: 404, origin });
      }
      const obj = await env.AVATARS.get(avatarKey(session.userId, avatarId));
      if (!obj) return json({ ok: false, error: 'avatar_not_found' }, { status: 404, origin });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg',
          'Cache-Control': 'private, max-age=300',
          ...corsHeaders(origin),
        },
      });
    },

    /** POST /api/me/avatars/:id/select — make it the session-start default. */
    async select(request, env, origin, avatarId) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      if (!AVATAR_ID_RE.test(avatarId)) {
        return json({ ok: false, error: 'avatar_not_found' }, { status: 404, origin });
      }
      const key = avatarKey(session.userId, avatarId);
      const head = await env.AVATARS.head(key);
      if (!head) return json({ ok: false, error: 'avatar_not_found' }, { status: 404, origin });
      await session.db.upsertProfile(session.userId, { avatarKey: key });
      return json({ ok: true }, { origin });
    },

    /** DELETE /api/me/avatars/:id — and clear the selection if it was this. */
    async remove(request, env, origin, avatarId) {
      const { refusal, session } = await requireUser(request, env, origin);
      if (refusal) return refusal;
      if (!AVATAR_ID_RE.test(avatarId)) {
        return json({ ok: false, error: 'avatar_not_found' }, { status: 404, origin });
      }
      const key = avatarKey(session.userId, avatarId);
      await env.AVATARS.delete(key);
      await session.db.clearProfileAvatarKeyIf(session.userId, key);
      return json({ ok: true }, { origin });
    },
  };
}

/**
 * Resolve a session-start avatar reference to base64 image data — used by
 * the video handlers when the client sends `avatarId` instead of inline
 * bytes. Same structural rule: the key is built from the RESOLVED user, so
 * someone else's avatar id simply does not exist in this user's namespace —
 * it resolves to null, never to their bytes.
 *
 * @returns {Promise<string|null>}
 */
export async function loadAvatarB64(env, userId, avatarId) {
  if (!env.AVATARS || !userId || !AVATAR_ID_RE.test(avatarId ?? '')) return null;
  const obj = await env.AVATARS.get(avatarKey(userId, avatarId));
  if (!obj) return null;
  const buf = new Uint8Array(await obj.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
