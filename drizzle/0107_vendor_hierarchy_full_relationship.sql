-- EH1 Phase 1 follow-up (2026-06-05) — full relationship model.
--
-- The minimal model from drizzle/0106 (role, parent_vendor_id,
-- default_display, override_permitted, display_preference) is being
-- extended to the full relationship model approved in
-- Dev-Spec-Vendor-Hierarchy-Phase1-2026-06-04.md so the schema can express:
--
--   - The distinct brand parent (what the customer sees on signage)
--     vs operator parent (who signs contracts / pays booth fees, e.g.
--     Esler Companies running 2 of 5 RbA franchises).
--   - The 8-shape relationship typology (branch / franchise / dealer /
--     member / agent / employee_branch / government / independent).
--   - Same-entity alias links (e.g. "Granite State Dock & Marine" vs
--     "Granite State Dock and Marine") distinct from parent-child links.
--   - The full display-mode vocabulary (`self`, `brand_parent`,
--     `operator_parent`, `both`) — the minimal model could only express
--     two of these.
--
-- This migration RENAMES four existing columns and ADDS three new ones,
-- then remaps the existing 6 backfilled rows' enum values to the new
-- vocabulary so no data is lost. SQLite/D1 supports ALTER TABLE RENAME
-- COLUMN (3.25+), so no table rebuild is needed.
--
-- The `role` column from 0106 stays — the existing render page, sitemap
-- SQL, and admin form rely on it as a fast NATIONAL / LOCAL_OFFICE /
-- INDEPENDENT discriminator, and the spec doesn't require dropping it.

-- 1) Drop the partial index that names the about-to-be-renamed column.
DROP INDEX IF EXISTS idx_vendors_parent_vendor_id;

-- 2) Rename the four existing hierarchy columns to match the spec
--    vocabulary. Data is preserved as-is by SQLite RENAME COLUMN.
ALTER TABLE vendors RENAME COLUMN parent_vendor_id   TO brand_parent_vendor_id;
ALTER TABLE vendors RENAME COLUMN default_display    TO default_child_display;
ALTER TABLE vendors RENAME COLUMN override_permitted TO display_override_permitted;
ALTER TABLE vendors RENAME COLUMN display_preference TO display_mode;

-- 3) Add the three new relationship columns. CHECK on relationship_type
--    is safe to inline at ADD COLUMN time since the column carries a
--    NOT NULL DEFAULT — every pre-existing row satisfies the constraint
--    immediately. CHECK on the two display enums is intentionally NOT
--    added here (matches the 0106 pattern: enforce in the Drizzle/Zod
--    layer instead of locking the column with a SQL CHECK that would
--    require a table rebuild to widen later).
ALTER TABLE vendors ADD COLUMN operator_parent_vendor_id TEXT
  REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE vendors ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'independent'
  CHECK (relationship_type IN
    ('branch','franchise','dealer','member','agent','employee_branch','government','independent'));
ALTER TABLE vendors ADD COLUMN alias_of_vendor_id TEXT
  REFERENCES vendors(id) ON DELETE SET NULL;

-- 4) Remap the existing rows' enum values to the spec vocabulary.
--    Live state (verified via CF MCP 2026-06-05): both NATIONAL parents
--    have default_display='LOCAL' and the 6 LOCAL_OFFICE children have
--    display_preference='INHERIT'. The UPDATEs are idempotent — each
--    filters on its own pre-state, so re-running is safe.
--
--    Old vocabulary  →  New vocabulary
--      LOCAL          →  'self'
--      NATIONAL       →  'brand_parent'
--      INHERIT        →  'inherit'
UPDATE vendors SET default_child_display = 'self'
  WHERE default_child_display = 'LOCAL';
UPDATE vendors SET default_child_display = 'brand_parent'
  WHERE default_child_display = 'NATIONAL';
UPDATE vendors SET display_mode = 'inherit'
  WHERE display_mode = 'INHERIT';
UPDATE vendors SET display_mode = 'self'
  WHERE display_mode = 'LOCAL';
UPDATE vendors SET display_mode = 'brand_parent'
  WHERE display_mode = 'NATIONAL';

-- 5) Seed relationship_type on the 6 already-linked children. Targeting
--    by brand_parent_vendor_id (rather than business_name LIKE) so the
--    UPDATE is precise. Per spec §6.1/§6.2: RbA franchises are
--    independent businesses ('franchise'); LeafFilter North-of-MA is a
--    W-2 branch ('branch'). The remaining backfill (Bath Fitter, NY
--    Life, Goodhue, single-office nationals, aliases) runs post-deploy
--    via the new admin MCP tools, not in-migration.
UPDATE vendors SET relationship_type = 'franchise'
  WHERE brand_parent_vendor_id = 'sys-vendor-rba-national'
    AND relationship_type = 'independent';
UPDATE vendors SET relationship_type = 'branch'
  WHERE brand_parent_vendor_id = 'sys-vendor-leaffilter-national'
    AND relationship_type = 'independent';

-- 6) Partial indexes — small because most vendors are unrelated.
--    Each index supports a different lookup path:
--      brand_parent_vendor_id    — children-of-brand fetch + national rollup
--      operator_parent_vendor_id — operator portfolio analytics
--      alias_of_vendor_id        — alias chain follow (resolveAlias)
CREATE INDEX IF NOT EXISTS idx_vendors_brand_parent_vendor_id
  ON vendors (brand_parent_vendor_id)
  WHERE brand_parent_vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_operator_parent_vendor_id
  ON vendors (operator_parent_vendor_id)
  WHERE operator_parent_vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_alias_of_vendor_id
  ON vendors (alias_of_vendor_id)
  WHERE alias_of_vendor_id IS NOT NULL;
