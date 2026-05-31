-- K3 (analyst, 2026-05-31). events.merged_into is the audit pointer
-- written by merge_events(keeper_id, duplicate_id) when an operator
-- collapses two events. Combined with the slug-rename + slug-history
-- insert that happens in the same merge transaction, this preserves
-- SEO equity: /events/<old-dup-slug> 301s to the keeper instead of
-- 404ing (the prior behavior of update_event_status → REJECTED).
--
-- Semantics:
--   merged_into IS NULL                    → row is its own canonical event
--                                            (the vast majority of rows)
--   merged_into = <other-event-id>         → row is a tombstone for the
--                                            merge winner; its slug has
--                                            been renamed to *-merged-<id>
--                                            and event_slug_history routes
--                                            the original slug to the
--                                            winner
--
-- ON DELETE SET NULL: if the keeper is later deleted, the pointer
-- becomes NULL rather than cascading the delete to the tombstone — the
-- tombstone stays around for audit. Matches the same semantics applied
-- to events.venue_id (set null on venue delete).
--
-- Pre-flight (per [[feedback_verify_table_doesnt_exist_before_create]]):
--   PRAGMA table_info('events');  -- confirm merged_into not present
--
-- Backfill: none. All existing events are their own canonical events.

ALTER TABLE events ADD COLUMN merged_into TEXT REFERENCES events(id) ON DELETE SET NULL;

-- Partial index — most events are NOT merged tombstones, so we only
-- need the index on the small subset that point at a keeper. Supports
-- the audit query "show me all events merged into X" and the
-- admin_actions reverse lookup.
CREATE INDEX IF NOT EXISTS idx_events_merged_into
  ON events(merged_into)
  WHERE merged_into IS NOT NULL;
