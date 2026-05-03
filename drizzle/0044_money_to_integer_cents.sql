-- Phase 6 (money precision cleanup, 2026-05-02)
--
-- Migrate ticket_price_min/_max and vendor_fee_min/_max from REAL (float
-- dollars) to INTEGER cents. Float storage loses precision under
-- accumulating arithmetic (the classic 0.1 + 0.2 ≠ 0.3 problem) — every
-- payment-processing system stores money as integer cents for this reason.
-- Currently the codebase doesn't process payments, but the next time it
-- does (Stripe / vendor-fee tracking / refunds), the data needs to be in
-- the right shape.
--
-- Strategy: add new *_cents columns, backfill from old * 100, drop old
-- columns. Same destructive pattern as 0041 (drop legacy event_vendor
-- boolean columns).
--
-- IMPORTANT: run `npm run db:backup` before applying. This migration
-- drops columns and cannot be auto-reverted.

ALTER TABLE events ADD COLUMN ticket_price_min_cents INTEGER;
ALTER TABLE events ADD COLUMN ticket_price_max_cents INTEGER;
ALTER TABLE events ADD COLUMN vendor_fee_min_cents   INTEGER;
ALTER TABLE events ADD COLUMN vendor_fee_max_cents   INTEGER;

UPDATE events SET ticket_price_min_cents = CAST(ROUND(ticket_price_min * 100) AS INTEGER) WHERE ticket_price_min IS NOT NULL;
UPDATE events SET ticket_price_max_cents = CAST(ROUND(ticket_price_max * 100) AS INTEGER) WHERE ticket_price_max IS NOT NULL;
UPDATE events SET vendor_fee_min_cents   = CAST(ROUND(vendor_fee_min   * 100) AS INTEGER) WHERE vendor_fee_min   IS NOT NULL;
UPDATE events SET vendor_fee_max_cents   = CAST(ROUND(vendor_fee_max   * 100) AS INTEGER) WHERE vendor_fee_max   IS NOT NULL;

ALTER TABLE events DROP COLUMN ticket_price_min;
ALTER TABLE events DROP COLUMN ticket_price_max;
ALTER TABLE events DROP COLUMN vendor_fee_min;
ALTER TABLE events DROP COLUMN vendor_fee_max;
