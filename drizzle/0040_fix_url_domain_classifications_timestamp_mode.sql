-- Phase 4 (date architecture cleanup, 2026-05-01)
--
-- Convert url_domain_classifications.created_at and updated_at from
-- raw-seconds storage to milliseconds storage to match every other
-- operational table on the project (which uses Drizzle's
-- integer({ mode: "timestamp" }) → ms-epoch).
--
-- Multiplying by 1000 brings existing 10-digit second values up to the
-- 13-digit millisecond form Drizzle expects when reading these columns
-- as Date objects. After this migration:
--   * old: 1714521600 (2024-05-01)  → new: 1714521600000 (still 2024-05-01)
--   * Drizzle will read these as `instanceof Date` instead of raw numbers
--
-- See `src/lib/db/schema.ts` `urlDomainClassifications` and the matching
-- copy in `mcp-server/src/schema.ts` — both updated alongside this file.
--
-- IMPORTANT: run `npm run db:backup` before applying to production. This
-- migration is destructive (overwrites existing column values) and cannot
-- be auto-reverted.

UPDATE url_domain_classifications SET created_at = created_at * 1000;
UPDATE url_domain_classifications SET updated_at = updated_at * 1000;
