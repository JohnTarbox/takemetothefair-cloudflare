-- Verified Pro tier scaffold (§6.6 doc — credentialed identity verification).
-- This migration ships the schema + admin-set mechanism + badge rendering.
-- The full identity-verification UX (LLC API, address validation, document
-- upload, vendor-facing request flow) is the Q1-2027 product feature; this
-- migration makes that future work a UI/integration task only, not a
-- schema/badge task.
--
-- Verified Pro is orthogonal to the four-tier model (MENTION/STUB/STANDARD/
-- ENHANCED). A vendor can be at any tier AND have Verified Pro independently
-- — it's a stronger trust badge layered on top of any tier.
--
-- Per business decision: Verified Pro grant fires NO vendor notification email
-- (admin-only credentialing, vendor sees badge appear on next visit). And
-- Claimed + Verified Pro are fully independent — admin grants each separately.

ALTER TABLE vendors ADD COLUMN verified_pro INTEGER NOT NULL DEFAULT 0;

-- Unix seconds (matches project convention; mode: "timestamp" in Drizzle is
-- seconds — see memory reference_drizzle_timestamp_mode_is_seconds.md).
ALTER TABLE vendors ADD COLUMN verified_pro_at INTEGER;

-- The admin who granted it. Nullable when verified_pro = 0.
ALTER TABLE vendors ADD COLUMN verified_pro_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Cheap index supporting future "all VP vendors" queries and the (likely)
-- VP-only filter on the admin recommendations panel.
CREATE INDEX idx_vendors_verified_pro ON vendors(verified_pro);
