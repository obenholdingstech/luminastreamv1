-- P4c — per-user voice clones (CEO isolation mandate, 7 Aug 2026: "An
-- ordinary user must only be able to query and use the … ElevenLabs voice
-- clones attached to their specific user_id").
--
-- One row = one vendor voice owned by one user. The vendor_voice_id is the
-- ElevenLabs id the agent synthesizes with; UNIQUE(user_id, vendor_voice_id)
-- makes double-registration idempotent, and the per-user index serves the
-- one query the product runs ("this user's voices") without a scan.
--
-- What is deliberately NOT here: no is_shared flag, no global visibility
-- column. Premade/stock voices are the vendor account's furniture and never
-- enter this table; sharing between users would be a P8 admin operation
-- with its own audit trail, not a column that a bug can flip.

CREATE TABLE user_voices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vendor_voice_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, vendor_voice_id)
);

CREATE INDEX idx_user_voices_user ON user_voices(user_id);
