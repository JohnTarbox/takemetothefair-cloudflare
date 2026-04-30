-- Vendor slug change history — for 301-redirecting old URLs after a
-- vendor changes their slug (typically when activating Enhanced Profile
-- with a custom_slug, but applies to any slug change).
--
-- The /vendors/[slug] route handler consults this table on 404 and
-- 301-redirects to the current slug. Chains are followed up to a max
-- depth (5 hops) to handle multiple consecutive renames.

CREATE TABLE vendor_slug_history (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  -- Optional admin user id (or null for cron / system writes).
  changed_by TEXT
);

CREATE INDEX idx_vendor_slug_history_old_slug ON vendor_slug_history(old_slug);
CREATE INDEX idx_vendor_slug_history_vendor_id ON vendor_slug_history(vendor_id);
