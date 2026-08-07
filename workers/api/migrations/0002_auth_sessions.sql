-- P4b — server-side sessions. The enterprise rule this table exists to
-- enforce: THE RAW SESSION TOKEN IS NEVER STORED. The browser holds the
-- token (HttpOnly cookie); the database holds only its SHA-256 — so a
-- database leak yields nothing a browser can present, the same reason the
-- video ledger hashes its settle credentials.
--
-- Sessions expire absolutely (expires_at) and record coarse activity
-- (last_seen_at, throttled updates — a per-request write would be an O(n)
-- bill on the busiest table in the system). Revocation is DELETE: sign-out
-- deletes one row, P8's admin "sign out everywhere" deletes by user_id.

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions (expires_at);
