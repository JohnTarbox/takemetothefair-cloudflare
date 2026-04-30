-- Enhanced Profile (Phase 1) — paid tier columns on vendors.
--
-- Background: kicks off MMATF's first paid product. Enhanced Profile is a
-- $29/yr admin-managed tier; admin flips the flag via MCP, no billing
-- system in Phase 1. See `set_enhanced_profile` in mcp-server/src/tools/admin.ts
-- for the activation path.
--
-- All columns additive and safe. Existing free vendors render exactly as
-- before; rendering branches only when enhanced_profile = 1.

ALTER TABLE vendors ADD COLUMN enhanced_profile INTEGER NOT NULL DEFAULT 0;

-- Set on initial activation; preserved across off→on cycles.
ALTER TABLE vendors ADD COLUMN enhanced_profile_started_at INTEGER;

-- Drives the 30-day grace period. When this is past, vendor is in grace.
-- When (this + 30 days) is past, the daily sweep flips enhanced_profile→0.
ALTER TABLE vendors ADD COLUMN enhanced_profile_expires_at INTEGER;

-- JSON array of {url, alt, caption?} objects. Max 2 entries enforced at
-- the validation layer, not the schema. Retained on flag→0 (data preserved).
ALTER TABLE vendors ADD COLUMN gallery_images TEXT NOT NULL DEFAULT '[]';

-- Pin override for featured rotation. Default 0 = participates in daily
-- shuffle. >0 = sorts above the shuffle, descending priority.
ALTER TABLE vendors ADD COLUMN featured_priority INTEGER NOT NULL DEFAULT 0;
