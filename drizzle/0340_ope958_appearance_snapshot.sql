-- OPE-958 — an appearance's source can be checked without re-fetching it, and
-- corrected without being overwritten.
--
-- The OPE-692 citation snapshot + recheck model, ported to event_performers with
-- the SAME column names, hash convention (sha256, first 16 hex) and recheck
-- vocabulary, because it is the same mechanism on a second table.
--
-- Semantics (John's ruling 2026-09-30: supersede, do not overwrite):
--   source_url            ACQUISITION provenance — where we learned it. Never
--                         rewritten.
--   last_verified_source  the RE-VERIFICATION target (OPE-123/791). A corrected
--                         source supersedes here; the previous value is kept in
--                         the admin_actions audit row.
--   source_title/excerpt/content_hash/fetched_at
--                         the snapshot of last_verified_source as read at the
--                         last verification — what a later pass compares
--                         against when it cannot re-fetch.
--   recheck_state/at/note the outcome of the last re-check.
--
-- ⚠️ Additive and NULL for every existing row. No backfill: existing
-- source_url values are true acquisition records (OPE-958 migration trap).
ALTER TABLE event_performers ADD COLUMN source_title TEXT;
ALTER TABLE event_performers ADD COLUMN source_excerpt TEXT;
ALTER TABLE event_performers ADD COLUMN source_content_hash TEXT;
ALTER TABLE event_performers ADD COLUMN source_fetched_at INTEGER;
-- 'unchecked' | 'confirmed' | 'changed' | 'unreachable' — TEXT with no CHECK,
-- matching drizzle/0256; the enum is enforced in TypeScript.
ALTER TABLE event_performers ADD COLUMN recheck_state TEXT;
ALTER TABLE event_performers ADD COLUMN recheck_at INTEGER;
ALTER TABLE event_performers ADD COLUMN recheck_note TEXT;
