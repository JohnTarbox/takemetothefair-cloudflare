-- OPE-686 — the maintenance half of the gallery.
--
-- OPE-211/212 shipped the store, the public UI and the APPEND half. An agent
-- could add a photo and could not fix one, so a duplicate upload and a
-- 90°-rotated photo on `phillips-old-home-days-2026` consumed a whole browser
-- session and still needed a human to click a native dialog.
--
-- Three columns, on both galleries, because the tables are the same shape and
-- a fix on one only would be the "wired into one of two parallel paths" defect
-- this codebase keeps rediscovering.
--
-- deleted_at
--   The existing DELETE route hard-deletes the D1 row. Its comment says the R2
--   object survives "so an accidental delete is recoverable" — but recovering
--   a row from a surviving object means knowing the id, caption, sort order and
--   featured flag that were destroyed with it. A tombstone keeps the record and
--   makes an over-eager dedup pass genuinely reversible, which is the property
--   the ticket asks for and the property the old comment only claimed.
--
-- content_sha256
--   The digest of the POST-processing bytes, so a double-submit returns the
--   existing photo instead of a second row. The incident is two byte-identical
--   rows eighteen seconds apart. Deliberately NOT a unique index: a soft-deleted
--   row must not block re-uploading the same picture later, and enforcing that
--   in an index would mean the tombstone we just added could silently refuse a
--   legitimate upload.
--
-- rotation
--   Degrees applied at RENDER time via `cdn-cgi/image`'s `rotate`, not baked
--   into the stored object. The Workers runtime has no image encoder — there is
--   no `sharp` here — so "re-encode in place" would mean a round trip through a
--   transform endpoint and a second write to R2, losing the original master to
--   a lossy re-encode every time somebody rotated a photo twice. A column is
--   lossless, reversible, and preserves photo_id, sort_order, is_featured and
--   caption by construction rather than by careful copying.

ALTER TABLE event_photos ADD COLUMN deleted_at INTEGER;
ALTER TABLE event_photos ADD COLUMN content_sha256 TEXT;
ALTER TABLE event_photos ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vendor_photos ADD COLUMN deleted_at INTEGER;
ALTER TABLE vendor_photos ADD COLUMN content_sha256 TEXT;
ALTER TABLE vendor_photos ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;

-- Every gallery read is "this owner's live photos, in order". Without
-- deleted_at in the index the tombstones are scanned on every page render.
CREATE INDEX IF NOT EXISTS idx_event_photos_live
  ON event_photos(event_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_vendor_photos_live
  ON vendor_photos(vendor_id, deleted_at, sort_order);

-- Dedup looks up (owner, digest) among LIVE rows only.
CREATE INDEX IF NOT EXISTS idx_event_photos_digest
  ON event_photos(event_id, content_sha256);
CREATE INDEX IF NOT EXISTS idx_vendor_photos_digest
  ON vendor_photos(vendor_id, content_sha256);
