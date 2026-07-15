-- OPE-211 — vendor gallery photos, the per-photo store `vendors.gallery_images`
-- can't be.
--
-- `gallery_images` (a JSON array of {url, alt, caption?}) stays in place and
-- keeps rendering the existing 2-up enhanced-profile gallery. It has no ids, no
-- ordering and no attribution, so a photo can't be reordered, captioned in
-- place, deleted individually, or traced to an uploader. This table is that
-- data's migration target, NOT a parallel store — the JSON column is read-only
-- legacy once the backfill runs (separate, STOP-gated step).
--
-- `vendors.logo_url` remains the canonical single brand logo; this is gallery
-- only. Shape is deliberately mirrorable by OPE-212's `event_photos`.
--
-- No thumb_url: this repo stores ONE master per image and derives every size at
-- render time via /cdn-cgi/image (src/lib/cdn-image.ts named variants). A stored
-- thumb would be a second source of truth for a derived value.
--
-- Verified against prod 2026-07-15 before writing: sqlite_master has no name
-- LIKE '%photo%' / '%media%' / '%gallery%' — this table is genuinely new.
CREATE TABLE vendor_photos (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  caption TEXT,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- booth | product | owner | other. Enforced in TS (VENDOR_PHOTO_TYPES), not by
  -- a CHECK, so adding a type doesn't need a migration — same call as
  -- vendors.enrichment_source.
  photo_type TEXT NOT NULL DEFAULT 'other',
  is_featured INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The gallery is always read as "this vendor's photos, in order".
CREATE INDEX idx_vendor_photos_vendor_sort ON vendor_photos (vendor_id, sort_order);
