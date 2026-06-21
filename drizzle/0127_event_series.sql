-- EH3 P0 (Dev-Reply-2026-06-21-EH3-Section-8-Decisions, 2026-06-21) — additive
-- schema for the Series + Occurrence model. NO reads at this phase: nothing in
-- the app or MCP server queries these structures yet. Backfill (P1) and the
-- visible series landing / SEO / tools (P2–P3) land in later, separately-shipped
-- phases per docs/eh3-scoping.md + docs/MMATF-EventOccurrence-Model-Redesign-2026-06-21.md.
--
-- Decision §8.1 — thin `event_series` parent (NOT single-table grouping). It is
-- the stable identity + canonical-metadata home for a recurring event; each
-- `events` row becomes one dated OCCURRENCE that may override these defaults.
-- This kills the cross-year vendor-roster contamination class by construction
-- (the 548-link Newport/Norwalk incident) once P1 links occurrences.
--
-- Decision §8.3 — URL Option A. `canonical_slug` is the year-agnostic series URL
-- (`/events/<series-slug>`); per-year occurrence pages live at
-- `/events/<series-slug>/<year>` and stay individually indexable (self-canonical
-- permanently). No canonical-up from past years. (Routing/301s arrive in P2.)
--
-- events.series_id is nullable: NULL = standalone one-off, which is EVERY
-- existing row at deploy — so this migration is invisible until P1 backfills.
-- ON DELETE SET NULL mirrors rolled_from_event_id (0124) / merged_into (0095):
-- deleting a series demotes its occurrences to standalone rather than cascading.
--
-- Verify not already present:
--   SELECT name FROM sqlite_master WHERE type='table' AND name='event_series';
--   PRAGMA table_info('events');   -- expect a series_id column after this runs

CREATE TABLE event_series (
  id                TEXT PRIMARY KEY,
  -- Year-agnostic canonical URL slug, e.g. "newport-international-boat-show".
  -- P1 backfill prefers the clean un-suffixed slug over a `…-<year>` sibling.
  canonical_slug    TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  -- Series defaults. An occurrence (events row) may override any of these for
  -- its specific year. venue/promoter are NULLABLE here — a series-level default,
  -- not a hard requirement (unlike events.promoter_id, which stays NOT NULL).
  venue_id          TEXT REFERENCES venues(id) ON DELETE SET NULL,
  promoter_id       TEXT REFERENCES promoters(id) ON DELETE SET NULL,
  recurrence_rule   TEXT,                            -- FREQ=YEARLY etc. (drives "next occurrence")
  description       TEXT,
  image_url         TEXT,
  categories        TEXT DEFAULT '[]',               -- JSON array, mirrors events.categories
  tags              TEXT DEFAULT '[]',               -- JSON array, mirrors events.tags
  primary_audience  TEXT NOT NULL DEFAULT 'PUBLIC',  -- PUBLIC | TRADE | MEMBERS (TAX1, 0100)
  public_access     TEXT NOT NULL DEFAULT 'OPEN',    -- OPEN | CLOSED (TAX1, 0100)
  created_at        INTEGER,
  updated_at        INTEGER
);

CREATE INDEX idx_event_series_venue_id ON event_series(venue_id);
CREATE INDEX idx_event_series_promoter_id ON event_series(promoter_id);

-- Each events row = one occurrence; series_id links it to its stable parent.
ALTER TABLE events ADD COLUMN series_id TEXT REFERENCES event_series(id) ON DELETE SET NULL;

CREATE INDEX idx_events_series_id ON events(series_id) WHERE series_id IS NOT NULL;
