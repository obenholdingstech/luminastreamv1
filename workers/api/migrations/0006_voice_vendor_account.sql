-- P4c follow-up (CEO architecture, 10 Aug 2026): vendor clones are
-- ACCOUNT-SCOPED at ElevenLabs — a voice cloned under one API key cannot be
-- synthesized with another (her question, confirmed). So every clone
-- records which pool key created it, by fingerprint (`k` + first 8 hex of
-- sha256(key)): stable across pool reordering, never the key itself.
--
-- A row whose fingerprint matches NO key in the current pool is an ORPHAN:
-- the operator removed that account's key (the explicit liveness signal),
-- and the voice healer re-clones it from OUR stored sample on the active
-- key. 'legacy' is the never-matches sentinel; zero production rows exist
-- at migration time (cloning was fail-closed until the key landed).

ALTER TABLE user_voices ADD COLUMN vendor_account TEXT NOT NULL DEFAULT 'legacy';
