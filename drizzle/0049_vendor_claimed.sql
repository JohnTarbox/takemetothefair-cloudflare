-- Vendor "Claimed" tier — positive-only signal that the business itself
-- maintains the listing. Distinct from enhanced_profile (paid) and from
-- userId (every vendor has one; that fact alone doesn't mean the real
-- owner has confirmed control).
--
-- Drives the Claimed badge (rendered on /vendors/[slug] and listing cards)
-- and the four-tier model's STANDARD-eligible-for-claim-outreach and
-- CLAIMED-ready-for-Enhanced-upsell recommendation rules.
--
-- All additive and safe. Existing vendors default to claimed=0; the flip
-- happens via admin PATCH (initial path) and via the self-serve
-- email-verification flow (later).

ALTER TABLE vendors ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0;

-- Unix seconds (matches project convention; mode: "timestamp" in Drizzle is
-- seconds, not ms — see memory reference_drizzle_timestamp_mode_is_seconds.md).
ALTER TABLE vendors ADD COLUMN claimed_at INTEGER;

-- The user who triggered the claim. Admin user ID for admin-set, vendor's
-- own user ID for self-serve. Nullable when claimed = 0.
ALTER TABLE vendors ADD COLUMN claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Cheap index supporting the recommendations rules that filter by claimed.
CREATE INDEX idx_vendors_claimed ON vendors(claimed);
