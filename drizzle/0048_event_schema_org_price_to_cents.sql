-- Phase 6 follow-up (money precision cleanup completion, 2026-05-03)
--
-- The 0044 migration moved events.ticket_price_*_cents and
-- events.vendor_fee_*_cents from REAL dollars to INTEGER cents, but missed
-- event_schema_org.schema_price_min/_max — the JSON-LD scraper output
-- table that's compared against events.ticket_price_*_cents in the admin
-- SchemaOrgPanel.
--
-- The mismatch forced SchemaOrgPanel to multiply schema prices by 100
-- on every render to compare apples-to-apples (see the TODO at
-- src/components/admin/SchemaOrgPanel.tsx:191). This migration cleans that
-- up so both sides use the same convention.
--
-- Strategy mirrors 0044: add new *_cents columns, backfill from old * 100,
-- drop old columns. Only 2 prod rows have non-null prices today (verified
-- 2026-05-03), so the destructive ALTER is low-risk.
--
-- IMPORTANT: run `npm run db:backup` before applying. This migration
-- drops columns and cannot be auto-reverted.

ALTER TABLE event_schema_org ADD COLUMN schema_price_min_cents INTEGER;
ALTER TABLE event_schema_org ADD COLUMN schema_price_max_cents INTEGER;

UPDATE event_schema_org
   SET schema_price_min_cents = CAST(ROUND(schema_price_min * 100) AS INTEGER)
 WHERE schema_price_min IS NOT NULL;

UPDATE event_schema_org
   SET schema_price_max_cents = CAST(ROUND(schema_price_max * 100) AS INTEGER)
 WHERE schema_price_max IS NOT NULL;

ALTER TABLE event_schema_org DROP COLUMN schema_price_min;
ALTER TABLE event_schema_org DROP COLUMN schema_price_max;
