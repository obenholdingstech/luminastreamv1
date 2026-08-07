-- P4c — avatar metadata, one row per stored avatar (CodeRabbit, PR 96).
--
-- The bytes live in R2 under avatars/<user_id>/<id>; THIS table exists so
-- the per-user cap can be atomic: an R2 prefix-count is a read-then-write
-- pair two concurrent uploads can both pass, while a conditional INSERT
-- guarded by COUNT(*) is one statement — the exact pattern user_voices
-- proved at PR 94. The row is the slot reservation; the object write
-- follows it, and a failed object write reconciles the row away.
--
-- `id` doubles as the R2 key's last segment, so key derivation stays
-- structural (avatars/<user_id>/<id>) and a row can never point at another
-- user's object.

CREATE TABLE user_avatars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_user_avatars_user ON user_avatars(user_id);
