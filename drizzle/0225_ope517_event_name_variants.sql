-- OPE-517 — an event can hold only one name, so every other name it is known by
-- is unfindable.
--
-- The Island Arts Association publishes twelve fairs. Dates, venues and hours
-- matched our twelve rows exactly. Every one of the twelve NAMES did not. The
-- Oct 10-11 fair alone has three names in circulation: the organizer's
-- ("October Craft Fair at Atlantic Oceanside"), the Bar Harbor Chamber's, and
-- ours ("Bar Harbor Fall Craft Fair 2026", 2,359 views). Someone searching the
-- name printed on the poster does not find the page we already rank for.
--
-- ⚠️ This is NOT a dedup table, and the distinction is the whole design.
-- `set_vendor_alias` means "this ROW is that row, differently spelled" — it
-- soft-deletes, renames a slug and repoints associations. Events already have
-- that: `merge_events`. This is the other thing: ONE surviving row, several
-- names it is legitimately known by, no second row anywhere in the picture.
--
-- A table rather than a JSON column on `events`, because a variant carries its
-- own provenance: which source called it this, and who recorded that. A JSON
-- blob cannot hold a source_url per entry without becoming a table with extra
-- steps.
CREATE TABLE IF NOT EXISTS event_name_variants (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  variant      TEXT NOT NULL,
  -- organizer_official | aggregator | historical | common_usage
  variant_type TEXT NOT NULL DEFAULT 'common_usage',
  source_url   TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);

-- One row per (event, variant). Re-recording the same name is a no-op rather
-- than a duplicate, so an unattended writer is safe to call repeatedly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_name_variants_unique
  ON event_name_variants (event_id, variant);

-- Search joins on this: the whole feature is decorative if a variant does not
-- match as readily as the canonical name.
CREATE INDEX IF NOT EXISTS idx_event_name_variants_variant
  ON event_name_variants (variant);
