-- OPE-1398 — hide the STREET address of self-signup vendors on public surfaces.
--
-- John's ruling (2026-10-16): a vendor that registered itself is often one
-- person working from home, so its street address is hidden by default on the
-- public vendor page, its JSON-LD, lists, public APIs and the non-admin export.
-- City, state and ZIP stay public; phone stays public; admin views unchanged.
-- The render rule is isStreetAddressHidden() in @takemetothefair/utils.
--
-- self_signup          — 1 when the vendor row was minted by /api/auth/register.
--                        Set by that route from now on; backfilled below.
-- show_street_address  — the vendor's own opt-back-in (profile checkbox).
--                        Default 0 = hidden for self-signup vendors.

ALTER TABLE vendors ADD COLUMN self_signup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN show_street_address INTEGER NOT NULL DEFAULT 0;

-- Backfill: the owner is a real registration (users.origin = 'registration')
-- AND the vendor was created in the same moment as that account (the register
-- route inserts both within one request). That second clause excludes vendors
-- that were admin/MCP/import-created and later CLAIMED by a person — the claim
-- flows reassign vendors.user_id, so an owner's origin alone would sweep those
-- in. Measured on prod 2026-10-16 (read-only): 199 rows match; every
-- registration-owned vendor that holds a street address is in that set.
--
-- No-op on an empty database (no rows to update; no foreign keys written).
-- Date columns are unix SECONDS.
UPDATE vendors
SET self_signup = 1
WHERE EXISTS (
  SELECT 1 FROM users u
  WHERE u.id = vendors.user_id
    AND u.origin = 'registration'
    AND ABS(vendors.created_at - u.created_at) <= 120
);
