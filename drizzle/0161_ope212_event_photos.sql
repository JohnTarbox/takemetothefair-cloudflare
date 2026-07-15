-- OPE-212 — event gallery photos. Column-for-column a mirror of vendor_photos
-- (drizzle/0160, OPE-211) keyed on event_id, so the shared upload pipeline can
-- dispatch on entity type instead of special-casing a bespoke shape.
--
-- `events.image_url` stays the canonical hero. `is_featured` marks the gallery's
-- own lead photo; it does not replace image_url, and OPE-204/205's
-- "hero-if-blank" writes still target image_url.
--
-- No thumb_url — one master per image, every size derived at render time via
-- /cdn-cgi/image (see 0160's note).
--
-- This is the store OPE-205's "general fair photos → event gallery candidates"
-- had nowhere to land in.
CREATE TABLE event_photos (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  caption TEXT,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- midway | vendors | food | stage | other. TS-enforced (EVENT_PHOTO_TYPES),
  -- not a CHECK — adding a type shouldn't need a migration.
  photo_type TEXT NOT NULL DEFAULT 'other',
  is_featured INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_event_photos_event_sort ON event_photos (event_id, sort_order);
