-- P4a — the system of record (ROADMAP §P4). The first storage in this
-- project whose job is to REMEMBER A PERSON between sessions — as opposed to
-- the Durable Objects, which coordinate concurrent requests and delete their
-- state when the session it describes ends.
--
-- Design decisions, made once, here:
--
-- * One user, many auth identities. Sign-in methods are rows, not columns
--   (CEO decision, 6 Aug 2026: email+password, Google, Apple — password
--   ships first; the OAuth providers join without a migration because the
--   shape already holds them).
-- * The lens profile is 1:1 with the user and holds exactly what the lens
--   loads at Start: voice, avatar, style prompt, and the sync trim the user
--   dialed. What today lives in localStorage graduates here.
-- * session_history is written by the machine at session end, never by the
--   client (the client that could report its own usage would report a small
--   one — the P2c settle lesson). vendor_summary stores the vendor's raw
--   response VERBATIM: P5's wallets and P8's reconciliation read the
--   vendor's number, never a paraphrase.
-- * Timestamps are unix seconds (INTEGER), ids are UUIDs minted in the
--   Worker. No AUTOINCREMENT anywhere — distributed writers hate counters.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  -- 'active' | 'suspended' — suspension is a P8 admin power, but the column
  -- exists NOW so enforcement is a WHERE clause, not a migration.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('password', 'google', 'apple')),
  -- password: the normalized email. google/apple: the provider's stable
  -- subject claim (NEVER the email — providers let emails change and hide).
  subject TEXT NOT NULL,
  -- password provider only; scrypt/PBKDF2 output, never reversible.
  password_hash TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (provider, subject),
  -- The credential invariant, enforced where it cannot be forgotten: a
  -- password identity MUST carry a hash, an OAuth identity MUST NOT (a hash
  -- on a google/apple row would be a credential nothing ever checks — the
  -- most dangerous kind).
  CHECK (
    (provider = 'password' AND password_hash IS NOT NULL)
    OR (provider IN ('google', 'apple') AND password_hash IS NULL)
  )
);
CREATE INDEX idx_auth_identities_user ON auth_identities (user_id);

CREATE TABLE lens_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  voice_id TEXT,
  voice_name TEXT,
  -- R2 object key for the reference avatar (P4c uploads it; the image bytes
  -- live in object storage, never in the database).
  avatar_key TEXT,
  style_prompt TEXT,
  video_path_ms INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session_history (
  id TEXT PRIMARY KEY,
  -- Nullable on purpose: pre-P4b sessions (admin-gate era) have no user, and
  -- history written before accounts exist is still history.
  user_id TEXT REFERENCES users(id),
  room TEXT NOT NULL,
  mode TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  tts_chars INTEGER NOT NULL DEFAULT 0,
  stt_seconds REAL NOT NULL DEFAULT 0,
  video_seconds REAL NOT NULL DEFAULT 0,
  -- The vendor's own billing summary, verbatim JSON. The COGS record P5
  -- debits against and P8 reconciles with (ROADMAP: emitted from P2 onward,
  -- aggregated at P9 — never produced later than it happened).
  vendor_summary TEXT
);
CREATE INDEX idx_session_history_user ON session_history (user_id, started_at);
