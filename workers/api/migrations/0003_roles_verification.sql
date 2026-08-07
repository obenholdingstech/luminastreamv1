-- Realignment (CEO directive, 7 Aug 2026): the admin-password gate retires;
-- identity carries authority instead.
--
-- * users.role — 'user' | 'admin'. Admin is BOOTSTRAPPED from the env-only
--   ADMIN_EMAILS allowlist at sign-in (never client-writable, never in the
--   public repo); everything the old admin password guarded becomes a role
--   check on a real account.
-- * email_verifications — one-shot tokens, HASHED at rest like every other
--   presentable credential in this system (a leaked table must never yield
--   a clickable link). Consumed on use, reaped by expiry; a user is
--   "verified" when at least one of their identities is (OAuth identities
--   arrive verified — the provider asserted the email; password identities
--   verify through these tokens once the mail provider lands).

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

CREATE TABLE email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- The exact identity subject being verified — verification must attach to
  -- the email it was SENT to, not whatever the account claims later.
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_email_verifications_user ON email_verifications (user_id);
CREATE INDEX idx_email_verifications_expiry ON email_verifications (expires_at);
