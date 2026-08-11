// The identity data layer (P4a) — a THIN wrapper over D1, deliberately
// boring: every function is one named query with explicit binds, so the SQL
// surface is enumerable, testable against a fake, and greppable when P8's
// admin asks "what can touch users?".
//
// Rules this layer enforces by shape:
// * ids and clocks are INJECTED (newId/now) — tests own time, and no query
//   sneaks a second clock in via SQL functions.
// * a suspended user resolves like a missing one at sign-in (`findIdentity`
//   joins the status check in) — enforcement is a WHERE clause, exactly what
//   the schema comment promised.
// * writes that must land together (user + first identity) go through
//   `batch()` — D1 batches are atomic per statement group.

/**
 * @param {any} d1 the D1 binding (env.IDENTITY_DB)
 * @param {{ newId?: () => string, now?: () => number }} [deps]
 */
export function createDb(d1, { newId = () => crypto.randomUUID(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  return {
    /**
     * A new user with their first sign-in identity, atomically.
     * @returns {Promise<{ userId: string }>}
     */
    async createUserWithIdentity({ provider, subject, passwordHash = null, displayName = null, verified = false }) {
      const userId = newId();
      const t = now();
      await d1.batch([
        d1
          .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
          .bind(userId, displayName, t),
        d1
          .prepare(
            'INSERT INTO auth_identities (id, user_id, provider, subject, password_hash, verified, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
          )
          .bind(newId(), userId, provider, subject, passwordHash, verified ? 1 : 0, t),
      ]);
      return { userId };
    },

    /**
     * Resolve a sign-in identity — suspended users resolve like missing ones,
     * so the caller has ONE failure path and no oracle for suspension.
     * @returns {Promise<{ userId: string, passwordHash: string|null, verified: boolean }|null>}
     */
    async findIdentity(provider, subject) {
      const row = await d1
        .prepare(
          'SELECT ai.user_id, ai.password_hash, ai.verified, u.role FROM auth_identities ai JOIN users u ON u.id = ai.user_id WHERE ai.provider = ?1 AND ai.subject = ?2 AND u.status = ?3',
        )
        .bind(provider, subject, 'active')
        .first();
      if (!row) return null;
      return {
        userId: row.user_id,
        passwordHash: row.password_hash ?? null,
        verified: Boolean(row.verified),
        role: row.role ?? 'user',
      };
    },

    /** @returns {Promise<any|null>} the user's saved lens identity, or null */
    async getProfile(userId) {
      const row = await d1.prepare('SELECT * FROM lens_profiles WHERE user_id = ?1').bind(userId).first();
      return row ?? null;
    },

    /**
     * Save the lens identity — partial updates keep unnamed fields, so a
     * voice change never erases an avatar.
     */
    async upsertProfile(userId, { voiceId, voiceName, avatarKey, stylePrompt, videoPathMs } = {}) {
      await d1
        .prepare(
          `INSERT INTO lens_profiles (user_id, voice_id, voice_name, avatar_key, style_prompt, video_path_ms, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (user_id) DO UPDATE SET
             voice_id = COALESCE(excluded.voice_id, voice_id),
             voice_name = COALESCE(excluded.voice_name, voice_name),
             avatar_key = COALESCE(excluded.avatar_key, avatar_key),
             style_prompt = COALESCE(excluded.style_prompt, style_prompt),
             video_path_ms = COALESCE(excluded.video_path_ms, video_path_ms),
             updated_at = excluded.updated_at`,
        )
        .bind(userId, voiceId ?? null, voiceName ?? null, avatarKey ?? null, stylePrompt ?? null, videoPathMs ?? null, now())
        .run();
    },

    /**
     * Clear the selected avatar ONLY if it is still this key — deleting an
     * avatar must never unselect a different one the user picked meanwhile.
     * (upsertProfile can't do this: its COALESCE semantics keep old values,
     * which is right for partial saves and wrong for deliberate clearing.)
     */
    async clearProfileAvatarKeyIf(userId, avatarKey) {
      await d1
        .prepare(
          'UPDATE lens_profiles SET avatar_key = NULL, updated_at = ?3 WHERE user_id = ?1 AND avatar_key = ?2',
        )
        .bind(userId, avatarKey, now())
        .run();
    },

    // ── user voices (P4c) — one row = one vendor voice owned by one user ──

    /** The caller's clones, nothing else's — the ONE product query. */
    async listUserVoices(userId) {
      const { results } = await d1
        .prepare('SELECT id, vendor_voice_id, label, vendor_account, language, created_at FROM user_voices WHERE user_id = ?1 ORDER BY created_at')
        .bind(userId)
        .all();
      return results ?? [];
    },

    /**
     * Register a clone UNDER the per-user cap, atomically: the count check
     * and the insert are ONE statement, so two concurrent clones cannot
     * both pass a read-then-write cap (CodeRabbit, PR 94 — the previous
     * list-then-insert pair was a TOCTOU race). Returns { id } when the
     * row landed, null when the cap refused it — and null means the CALLER
     * must compensate at the vendor, because the vendor voice already
     * exists by the time this runs.
     *
     * (Vendor ids are fresh per clone, so there is no conflict path here —
     * the UNIQUE constraint would surface a true double-registration as a
     * thrown error, which is the loud version of a bug we want to hear.)
     */
    async addUserVoice(userId, { id = newId(), vendorVoiceId, label, cap, vendorAccount = 'legacy', language = null }) {
      // `id` may arrive from the caller: the clone flow mints it BEFORE the
      // vendor call so the stored sample (voice-samples/<user>/<id>) and the
      // row share an identity from birth. `language` persists so healing can
      // replay the conditioning hint.
      const res = await d1
        .prepare(
          `INSERT INTO user_voices (id, user_id, vendor_voice_id, label, vendor_account, language, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE (SELECT COUNT(*) FROM user_voices WHERE user_id = ?2) < ?8`,
        )
        .bind(id, userId, vendorVoiceId, label, vendorAccount, language, now(), cap)
        .run();
      const changes = res?.meta?.changes ?? res?.changes ?? 0;
      return changes >= 1 ? { id } : null;
    },

    /**
     * The healer's write, as a COMPARE-AND-SWAP: the update lands only if
     * the row still carries the vendor identity the healer read (two
     * concurrent heals cannot both win — the loser learns it lost and
     * compensates its duplicate clone at the vendor; CodeRabbit, PR 104).
     * Returns whether THIS caller won. Scoped by id AND user_id.
     */
    async updateUserVoiceVendorIf(userId, id, { expectedVendorVoiceId, vendorVoiceId, vendorAccount }) {
      const res = await d1
        .prepare(
          'UPDATE user_voices SET vendor_voice_id = ?4, vendor_account = ?5 WHERE id = ?1 AND user_id = ?2 AND vendor_voice_id = ?3',
        )
        .bind(id, userId, expectedVendorVoiceId, vendorVoiceId, vendorAccount)
        .run();
      return (res?.meta?.changes ?? res?.changes ?? 0) >= 1;
    },

    /**
     * After a heal, the saved selection follows the voice: remap the
     * profile's voice_id ONLY if it still points at the old vendor id.
     */
    async remapProfileVoiceId(userId, oldVendorId, newVendorId) {
      await d1
        .prepare(
          'UPDATE lens_profiles SET voice_id = ?3, updated_at = ?4 WHERE user_id = ?1 AND voice_id = ?2',
        )
        .bind(userId, oldVendorId, newVendorId, now())
        .run();
    },

    /** One row, scoped by BOTH id and user_id — someone else's row id
     * resolves to null, same no-oracle rule as everywhere. */
    async findUserVoice(userId, id) {
      const row = await d1
        .prepare('SELECT id, vendor_voice_id, label, vendor_account, language FROM user_voices WHERE id = ?1 AND user_id = ?2')
        .bind(id, userId)
        .first();
      return row ?? null;
    },

    /**
     * Remove a clone registration — scoped by BOTH id and user_id, so a
     * leaked row id from another account deletes nothing.
     */
    async removeUserVoice(userId, id) {
      await d1
        .prepare('DELETE FROM user_voices WHERE id = ?1 AND user_id = ?2')
        .bind(id, userId)
        .run();
    },

    // ── user avatars (P4c) — the row is the slot, the bytes live in R2 ──

    /**
     * Reserve an avatar slot UNDER the cap, atomically — the count guard
     * lives IN the insert (the user_voices pattern, PR 94/96). Returns true
     * when the row landed; false means the cap refused and nothing was
     * written anywhere.
     */
    async addUserAvatar(userId, { avatarId, name, contentType, size, cap }) {
      const res = await d1
        .prepare(
          `INSERT INTO user_avatars (id, user_id, name, content_type, size, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (SELECT COUNT(*) FROM user_avatars WHERE user_id = ?2) < ?7`,
        )
        .bind(avatarId, userId, name, contentType, size, now(), cap)
        .run();
      const changes = res?.meta?.changes ?? res?.changes ?? 0;
      return changes >= 1;
    },

    /** The caller's avatars, nothing else's. */
    async listUserAvatars(userId) {
      const { results } = await d1
        .prepare(
          'SELECT id, name, content_type, size, created_at FROM user_avatars WHERE user_id = ?1 ORDER BY created_at',
        )
        .bind(userId)
        .all();
      return results ?? [];
    },

    /** One row, scoped by BOTH id and user_id — the no-oracle rule. */
    async findUserAvatar(userId, avatarId) {
      const row = await d1
        .prepare('SELECT id, name, content_type, size FROM user_avatars WHERE id = ?1 AND user_id = ?2')
        .bind(avatarId, userId)
        .first();
      return row ?? null;
    },

    /** Remove the slot — scoped by BOTH id and user_id. */
    async removeUserAvatar(userId, avatarId) {
      await d1
        .prepare('DELETE FROM user_avatars WHERE id = ?1 AND user_id = ?2')
        .bind(avatarId, userId)
        .run();
    },

    // ── admin reads + the one admin mutation (P8, pulled forward) ──

    /** Everyone, newest first, with the facts the console renders. */
    async listUsers(limit) {
      const { results } = await d1
        .prepare(
          `SELECT u.id, u.display_name, u.role, u.status, u.created_at,
             (SELECT ai.subject FROM auth_identities ai WHERE ai.user_id = u.id ORDER BY ai.created_at LIMIT 1) AS email,
             (SELECT MAX(ai.verified) FROM auth_identities ai WHERE ai.user_id = u.id) AS verified,
             (SELECT COUNT(*) FROM user_voices v WHERE v.user_id = u.id) AS voices,
             (SELECT COUNT(*) FROM user_avatars a WHERE a.user_id = u.id) AS avatars
           FROM users u ORDER BY u.created_at DESC LIMIT ?1`,
        )
        .bind(limit)
        .all();
      return results ?? [];
    },

    /** The headline numbers. */
    async countUsers() {
      const row = await d1
        .prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
             SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
           FROM users`,
        )
        .first();
      return {
        total: row?.total ?? 0,
        active: row?.active ?? 0,
        suspended: row?.suspended ?? 0,
        admins: row?.admins ?? 0,
      };
    },

    /** One user by id — for existence checks before the status write. */
    async findUserById(userId) {
      const row = await d1
        .prepare('SELECT id, display_name, role, status FROM users WHERE id = ?1')
        .bind(userId)
        .first();
      return row ?? null;
    },

    /**
     * The admin status write. Enforcement costs nothing extra: every
     * session resolver and sign-in query already filters status = 'active',
     * so a suspended user's cookies die at their next request.
     */
    async setUserStatus(userId, status) {
      await d1
        .prepare('UPDATE users SET status = ?2, updated_at = ?3 WHERE id = ?1')
        .bind(userId, status, now())
        .run();
    },

    /** The recent session history, newest first, verbatim columns. */
    async recentSessions(limit) {
      const { results } = await d1
        .prepare(
          'SELECT id, user_id, room, mode, started_at FROM session_history ORDER BY started_at DESC LIMIT ?1',
        )
        .bind(limit)
        .all();
      return results ?? [];
    },

    /** A session opened — written by the machine, never the client. */
    async recordSessionStart({ userId = null, room, mode = null }) {
      const id = newId();
      await d1
        .prepare('INSERT INTO session_history (id, user_id, room, mode, started_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(id, userId, room, mode, now())
        .run();
      return { historyId: id };
    },

    // ── auth sessions (P4b) — the row is the session; DELETE is revocation ──

    /** Store a session by its HASH — the raw token never touches a row. */
    async createAuthSession({ tokenHash, userId, ttlSeconds }) {
      const t = now();
      await d1
        .prepare(
          'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)',
        )
        .bind(tokenHash, userId, t, t + ttlSeconds)
        .run();
    },

    /**
     * Resolve a session: unexpired, user still active — one query, one
     * failure path (an expired session, a deleted one, and a suspended user
     * all resolve to null).
     */
    async findAuthSession(tokenHash) {
      const row = await d1
        .prepare(
          'SELECT s.user_id, s.last_seen_at, u.display_name, u.role, EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id = u.id AND ai.verified = 1) AS verified FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.status = ?3',
        )
        .bind(tokenHash, now(), 'active')
        .first();
      if (!row) return null;
      return {
        userId: row.user_id,
        lastSeenAt: row.last_seen_at,
        displayName: row.display_name ?? null,
        role: row.role ?? 'user',
        verified: Boolean(row.verified),
      };
    },

    /** Coarse activity, throttled by the CALLER — this just writes. */
    async touchAuthSession(tokenHash) {
      await d1
        .prepare('UPDATE auth_sessions SET last_seen_at = ?2 WHERE token_hash = ?1')
        .bind(tokenHash, now())
        .run();
    },

    /** Sign-out: revocation is deletion. Idempotent by nature. */
    async deleteAuthSession(tokenHash) {
      await d1.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(tokenHash).run();
    },

    /** Opportunistic hygiene — called from sign-in, bounded by predicate. */
    async deleteExpiredAuthSessions() {
      await d1.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?1').bind(now()).run();
    },

    // ── email verification (realignment) — one-shot, hashed, expiring ──

    async createEmailVerification({ tokenHash, userId, subject, ttlSeconds }) {
      const t = now();
      await d1
        .prepare(
          'INSERT INTO email_verifications (token_hash, user_id, subject, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(tokenHash, userId, subject, t, t + ttlSeconds)
        .run();
    },

    /** Read-and-burn: the row is deleted whether or not it was still valid,
     * so a token can never be replayed — one click, one chance. */
    async consumeEmailVerification(tokenHash) {
      const row = await d1
        .prepare('SELECT user_id, subject, expires_at FROM email_verifications WHERE token_hash = ?1')
        .bind(tokenHash)
        .first();
      await d1.prepare('DELETE FROM email_verifications WHERE token_hash = ?1').bind(tokenHash).run();
      if (!row || row.expires_at <= now()) return null;
      return { userId: row.user_id, subject: row.subject };
    },

    /** The password identity's email for a user (resend needs a target). */
    async findIdentitySubject(userId) {
      const row = await d1
        .prepare("SELECT subject FROM auth_identities WHERE user_id = ?1 AND provider = 'password'")
        .bind(userId)
        .first();
      return row ?? null;
    },

    /** Verification attaches to the identity the mail was SENT to. */
    async markIdentityVerified(userId, subject) {
      await d1
        .prepare('UPDATE auth_identities SET verified = 1 WHERE user_id = ?1 AND subject = ?2')
        .bind(userId, subject)
        .run();
    },

    /** The ADMIN_EMAILS bootstrap writes roles; nothing client-facing does. */
    async setRole(userId, role) {
      await d1
        .prepare('UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1')
        .bind(userId, role, now())
        .run();
    },

    /** Rehash-on-signin: the fleet strengthens without a password reset. */
    async updatePasswordHash(provider, subject, passwordHash) {
      await d1
        .prepare('UPDATE auth_identities SET password_hash = ?3 WHERE provider = ?1 AND subject = ?2')
        .bind(provider, subject, passwordHash)
        .run();
    },

    /**
     * The session's end and its COGS record (vendor summary VERBATIM).
     * Idempotent by predicate: a retry can never overwrite a finalized
     * record — the first close wins, the second matches zero rows.
     */
    async closeSession(historyId, { ttsChars = 0, sttSeconds = 0, videoSeconds = 0, vendorSummary = null } = {}) {
      await d1
        .prepare(
          'UPDATE session_history SET ended_at = ?2, tts_chars = ?3, stt_seconds = ?4, video_seconds = ?5, vendor_summary = ?6 WHERE id = ?1 AND ended_at IS NULL',
        )
        .bind(historyId, now(), ttsChars, sttSeconds, videoSeconds, vendorSummary ? JSON.stringify(vendorSummary) : null)
        .run();
    },
  };
}
