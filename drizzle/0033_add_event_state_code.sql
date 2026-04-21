-- Phase: promote state scope onto events directly so events without a physical
-- venue (statewide tours, multi-location trails) can appear on /events/<state>
-- pages without needing a placeholder venue row.
--
-- Before: state listing queries innerJoin venues and filter on venues.state,
-- which forces every listable event to have a venue. This led to a "Statewide"
-- placeholder venue being created in ME purely to carry events like Maine
-- Pottery Tour and Maine Open Lighthouse Day. That venue leaks into every
-- venue surface (directory, detail page, sitemap, pickers, search).
--
-- After: events.state_code is denormalized from venue.state for venue-backed
-- events and set directly for statewide events. events.is_statewide drives
-- the card template's "Statewide — <State>" chip. The placeholder venue row
-- and any orphaned favorites/links are removed.

ALTER TABLE events ADD COLUMN state_code TEXT;
ALTER TABLE events ADD COLUMN is_statewide INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_state_code ON events(state_code);

-- Backfill: copy state from the attached venue for every venue-backed event.
-- Safe to re-run; the WHERE state_code IS NULL clause protects already-set rows.
UPDATE events
SET state_code = (SELECT v.state FROM venues v WHERE v.id = events.venue_id)
WHERE venue_id IS NOT NULL AND state_code IS NULL;

-- Promote events attached to the ME "Statewide" placeholder venue to
-- first-class statewide events: set the flag, null out the fake venue link.
UPDATE events
SET is_statewide = 1,
    state_code = 'ME',
    venue_id = NULL
WHERE venue_id = '50e44344-7fbc-4c09-a5d5-cc5cc6261d50';

-- Clean up any polymorphic references to the placeholder venue before deleting it
-- (userFavorites and content_links use soft polymorphic refs without FKs, so a
-- direct DELETE on venues would leave them dangling).
DELETE FROM user_favorites
WHERE favoritable_type = 'VENUE'
  AND favoritable_id = '50e44344-7fbc-4c09-a5d5-cc5cc6261d50';

DELETE FROM content_links
WHERE target_type = 'VENUE'
  AND target_id = '50e44344-7fbc-4c09-a5d5-cc5cc6261d50';

-- Finally, drop the placeholder venue row itself.
DELETE FROM venues WHERE id = '50e44344-7fbc-4c09-a5d5-cc5cc6261d50';
