// P8 (pulled forward by the CEO, 9 Aug 2026) — the admin API. The page's
// redirect is UX; THIS is the wall: every endpoint resolves the cookie
// session and requires role === 'admin' before touching anything. The ops
// X-Admin-Token deliberately opens none of these — it is a machine
// credential for probes, and people-administration belongs to people.
//
// What lives here is READ plus exactly one mutation — user status — because
// suspension already has enforcement-grade teeth: every session resolver
// and sign-in query filters status = 'active', so a suspended user's
// sessions die at the next request with no new machinery. Money mutations
// (grants, refunds) deliberately wait for P5's wallets — the admin console
// must never invent a second money path.

const USER_PAGE_LIMIT = 50;

/**
 * @param {object} kit — { json, readJson, clientIp, checkRateLimit,
 *   rateLimitRefusal, createDb, resolveUserSession, callRegistry, callLedger }
 */
export function createAdminRoutes(kit) {
  const {
    json,
    readJson,
    clientIp,
    checkRateLimit,
    rateLimitRefusal,
    createDb,
    resolveUserSession,
    callRegistry,
    callLedger,
  } = kit;

  // Limiter → session → role, in the house order. 401 for no session, 403
  // for a session without the role — the same distinction the rest of the
  // API draws between "who are you" and "you may not".
  async function requireAdmin(request, env, origin) {
    const limited = rateLimitRefusal(
      await checkRateLimit(env.TOKEN_LIMITER, `admin:${clientIp(request)}`),
      origin,
    );
    if (limited) return { refusal: limited };
    const session = await resolveUserSession(request, env, createDb);
    if (!session) {
      return { refusal: json({ ok: false, error: 'unauthenticated' }, { status: 401, origin }) };
    }
    if (session.role !== 'admin') {
      return { refusal: json({ ok: false, error: 'admin_only' }, { status: 403, origin }) };
    }
    return { session };
  }

  /** A DO answer, or null — the overview must render with a limb missing
   * rather than 500 because one binding hiccuped. */
  async function tryJson(promise) {
    try {
      const res = await promise;
      if (!res) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  return {
    /** GET /api/admin/overview — is the product alive, what is it costing. */
    async overview(request, env, origin) {
      const { refusal, session } = await requireAdmin(request, env, origin);
      if (refusal) return refusal;
      const [counts, capacity, budget] = await Promise.all([
        session.db.countUsers(),
        tryJson(callRegistry(env, '/capacity')),
        tryJson(callLedger(env, '/budget')),
      ]);
      return json(
        {
          ok: true,
          users: counts,
          capacity: capacity?.ok ? capacity : null,
          videoBudget: budget?.ok ? budget : null,
          voiceCloningEnabled: Boolean(env.ELEVENLABS_API_KEY),
        },
        { origin },
      );
    },

    /** GET /api/admin/users — newest first, with the facts that matter. */
    async users(request, env, origin) {
      const { refusal, session } = await requireAdmin(request, env, origin);
      if (refusal) return refusal;
      const rows = await session.db.listUsers(USER_PAGE_LIMIT);
      return json(
        {
          ok: true,
          users: rows.map((u) => ({
            id: u.id,
            email: u.email ?? null,
            displayName: u.display_name ?? null,
            role: u.role ?? 'user',
            status: u.status,
            verified: Boolean(u.verified),
            createdAt: u.created_at,
            voices: u.voices ?? 0,
            avatars: u.avatars ?? 0,
          })),
        },
        { origin },
      );
    },

    /** GET /api/admin/sessions — the recent session history, verbatim. */
    async sessions(request, env, origin) {
      const { refusal, session } = await requireAdmin(request, env, origin);
      if (refusal) return refusal;
      const rows = await session.db.recentSessions(30);
      return json({ ok: true, sessions: rows }, { origin });
    },

    /** GET /api/admin/settlements — the ledger's audit trail, read-only. */
    async settlements(request, env, origin) {
      const { refusal } = await requireAdmin(request, env, origin);
      if (refusal) return refusal;
      const out = await tryJson(callLedger(env, '/settlements'));
      return json({ ok: true, settlements: out?.settlements ?? [] }, { origin });
    },

    /**
     * POST /api/admin/users/:id/status { status: 'active' | 'suspended' }.
     * The one mutation. Self-suspension refuses — an admin locking
     * themselves out of the console that could undo it is not a state this
     * API can express. Enforcement is instant and free: every resolver
     * already filters status = 'active'.
     */
    async setUserStatus(request, env, origin, userId) {
      const { refusal, session } = await requireAdmin(request, env, origin);
      if (refusal) return refusal;
      const body = await readJson(request);
      const status = body?.status;
      if (status !== 'active' && status !== 'suspended') {
        return json({ ok: false, error: 'status_invalid' }, { status: 400, origin });
      }
      if (userId === session.userId) {
        return json({ ok: false, error: 'cannot_change_own_status' }, { status: 400, origin });
      }
      const target = await session.db.findUserById(userId);
      if (!target) return json({ ok: false, error: 'user_not_found' }, { status: 404, origin });
      await session.db.setUserStatus(userId, status);
      return json({ ok: true, id: userId, status }, { origin });
    },
  };
}
