// P4c — per-user voice listing (CEO isolation mandate, 7 Aug 2026). The
// query is scoped by the resolved session's userId — the endpoint has no
// parameter that could name anyone else. Clone CREATION (ElevenLabs IVC)
// arrives with P4c-3 and will fail closed until the vendor key exists on
// the Worker; this module ships the read side so the policy stamp in the
// session grant (index.js) and the UI both have one source of truth.

/**
 * @param {object} kit — { json, clientIp, checkRateLimit, rateLimitRefusal,
 *   createDb, resolveUserSession }
 */
export function createVoiceRoutes(kit) {
  const { json, clientIp, checkRateLimit, rateLimitRefusal, createDb, resolveUserSession } = kit;

  return {
    /** GET /api/me/voices — the caller's clones, nothing else's. */
    async list(request, env, origin) {
      const limited = rateLimitRefusal(
        await checkRateLimit(env.TOKEN_LIMITER, `voices:${clientIp(request)}`),
        origin,
      );
      if (limited) return limited;
      const session = await resolveUserSession(request, env, createDb);
      if (!session) {
        return json({ ok: false, error: 'unauthenticated' }, { status: 401, origin });
      }
      const voices = await session.db.listUserVoices(session.userId);
      return json(
        {
          ok: true,
          voices: voices.map((v) => ({ id: v.id, voiceId: v.vendor_voice_id, label: v.label })),
        },
        { origin },
      );
    },
  };
}
