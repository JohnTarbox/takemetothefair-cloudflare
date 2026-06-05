-- EH1 Phase 1 (2026-06-05) — national-brand / local-office vendor data model.
--
-- Adds 5 columns to `vendors` for the hierarchy John promoted to PRIORITY
-- QUEUED 2026-06-03. **Phase 1 is data-model + backfill ONLY** — no public
-- render change at deploy. Phase 2 (deferred to a separate PR) wires the
-- display-resolution logic + canonical/SEO handling + claim interaction.
--
-- Why both `default_display` (parent-controlled) AND `display_preference`
-- (child-set) with `override_permitted` as the gate: per John's 2026-06-03
-- decision, the parent owns the default, the child can request a different
-- preference, but the parent's `override_permitted` flag decides whether the
-- preference is honored. A claim by a local office grants edit rights but
-- never bypasses the gate. See project_national_local_vendor_model.md.
--
-- Backwards-compat: every existing vendor row stays the role=INDEPENDENT
-- default with all hierarchy fields NULL/false. Public renderer doesn't
-- look at these columns until Phase 2 ships, so deploy is invisible.

ALTER TABLE vendors ADD COLUMN role TEXT NOT NULL DEFAULT 'INDEPENDENT';
-- 'NATIONAL' | 'LOCAL_OFFICE' | 'INDEPENDENT'
--   NATIONAL     — the parent record (LeafFilter HQ, Renewal by Andersen)
--   LOCAL_OFFICE — a franchise / regional office under a parent
--   INDEPENDENT  — every other vendor (default — no hierarchy)
-- Not enum-constrained at the SQL layer to keep the migration reversible
-- without a table rewrite; constrained at the Drizzle schema layer.

ALTER TABLE vendors ADD COLUMN parent_vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL;
-- FK to the NATIONAL parent for LOCAL_OFFICE rows. NULL for NATIONAL
-- and INDEPENDENT. ON DELETE SET NULL so deleting a parent doesn't
-- cascade-orphan-kill the offices (operator can re-parent manually).

ALTER TABLE vendors ADD COLUMN default_display TEXT;
-- 'NATIONAL' | 'LOCAL' — only meaningful on NATIONAL rows. NULL otherwise.
-- The parent's choice for what surfaces publicly when no child override
-- applies. Parent picks "LOCAL" when local offices are the customer-
-- facing entity (e.g. RbA — quotes / appointments are franchise-scoped).
-- Parent picks "NATIONAL" when the brand is the customer-facing entity
-- (e.g. a national e-commerce store).

ALTER TABLE vendors ADD COLUMN override_permitted INTEGER NOT NULL DEFAULT 0;
-- Boolean (0/1). Only meaningful on LOCAL_OFFICE rows. Parent-controlled
-- gate that decides whether the child's display_preference is honored.
-- Default 0 (gate closed) — the parent's default_display always wins
-- until the parent explicitly grants override.

ALTER TABLE vendors ADD COLUMN display_preference TEXT;
-- 'NATIONAL' | 'LOCAL' | 'INHERIT' — only meaningful on LOCAL_OFFICE
-- rows. NULL on NATIONAL and INDEPENDENT. The child's requested
-- preference. INHERIT is the default-equivalent (fall through to
-- parent.default_display). When override_permitted=1, NATIONAL/LOCAL
-- here wins over parent.default_display.

-- Partial indexes — most vendors are INDEPENDENT, so partials keep
-- these small.

CREATE INDEX IF NOT EXISTS idx_vendors_parent_vendor_id
  ON vendors (parent_vendor_id)
  WHERE parent_vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendors_role
  ON vendors (role)
  WHERE role != 'INDEPENDENT';
