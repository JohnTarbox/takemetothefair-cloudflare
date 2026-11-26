-- OPE-1606 (John, 2026-11-10) — commercial_vendors_allowed was a column default,
-- not data. NULL now means unknown.
--
-- Cites docs/bulk-mutation-discipline.md.
--
-- Add, copy the deliberate values, drop, rename. SQLite cannot drop a column
-- default in place, and rebuilding `events` would endanger its FK children.
-- DROP COLUMN does not touch them, and nothing indexes this column.
--
-- Kept: every 0, and a 1 that was set on purpose or has vendor evidence (an
-- application URL, a fee or a deadline, the fairsandfestivals scraper, or an
-- admin-form row). Written as a copy of what is kept, so a row whose predicate
-- evaluates to NULL is not copied and lands on unknown, the safe direction.
--
-- Single writer (this migration), once (d1_migrations). Safe on an EMPTY database.
-- Rollback: every row this nulls held 1. Restore with
--   UPDATE events SET commercial_vendors_allowed = 1 WHERE commercial_vendors_allowed IS NULL
-- excluding the two rows that were already NULL:
--   b52c6acf-091e-4b3f-87f7-aa4b05e629c8, 8fd8cbb5-4a9b-424d-b543-110f0e6f4f4e
ALTER TABLE events ADD COLUMN commercial_vendors_allowed_new INTEGER;
UPDATE events SET commercial_vendors_allowed_new = commercial_vendors_allowed
WHERE commercial_vendors_allowed = 0
   OR (commercial_vendors_allowed = 1 AND (
        NULLIF(TRIM(application_url), '') IS NOT NULL
        OR vendor_fee_min_cents IS NOT NULL
        OR vendor_fee_max_cents IS NOT NULL
        OR application_deadline IS NOT NULL
        OR COALESCE(source_domain, '') LIKE '%fairsandfestivals%'
        OR COALESCE(ingestion_method, '') = 'admin_manual'
      ));
ALTER TABLE events DROP COLUMN commercial_vendors_allowed;
ALTER TABLE events RENAME COLUMN commercial_vendors_allowed_new TO commercial_vendors_allowed;
