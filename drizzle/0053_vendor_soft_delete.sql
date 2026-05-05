-- Vendor soft-delete + 301-redirect target. Per the dev team's delete_vendor
-- spec: most vendor cleanups are duplicate consolidations where the duplicate
-- needs to redirect to the canonical version, NOT a true hard delete.
--
-- Soft-delete primitive:
--   deleted_at = non-null   → vendor is invisible everywhere (sitemap,
--                              listings, event pages, recommendations,
--                              JSON-LD). Public URL returns 410 Gone (or
--                              301 to redirect_to_vendor_id if set).
--   deleted_at = NULL       → vendor is live (default).
--
-- 30-day grace window: a separate manual sweep endpoint
-- (/api/admin/vendors/sweep-purge-deleted) hard-deletes rows where
-- deleted_at < now - 30d.
--
-- redirect_to_vendor_id: optional. When set, the soft-deleted vendor's
-- URL 301-redirects to the target vendor's URL. ON DELETE SET NULL
-- handles the case where the target itself gets purged later (redirect
-- silently drops back to 410).

ALTER TABLE vendors ADD COLUMN deleted_at INTEGER;

ALTER TABLE vendors ADD COLUMN redirect_to_vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL;

-- Cheap index for the WHERE deleted_at IS NULL filter that goes on every
-- public-surface query (sitemap, listings, event vendor lists, etc.).
CREATE INDEX idx_vendors_deleted_at ON vendors(deleted_at);
