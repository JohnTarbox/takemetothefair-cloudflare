-- OPE-490 — the two duplicate `event_series` pairs OPE-473 could not see.
--
-- OPE-473's planning snapshot filtered `venue_id IS NULL`, so 26 rows never
-- reached scripts/ope473/plan-consolidation.ts. Re-run against prod 2026-08-19,
-- TWO groups qualify (the close-out note recorded one):
--
--   1. Maine Pottery Tour            — both rows venue_id NULL
--   2. Fiber Festival of New England — one row venued, its twin venue_id NULL.
--      A second shape: even without the NULL filter the `name + venue_id` key
--      would not have grouped these, because NULL never equals the venue uuid.
--
-- 2 groups, 2 duplicate parents retired, 2 events re-parented, 2 redirects.
--
-- KEEPER RULE: unchanged from OPE-473 rule 1 — `canonical_slug == createSlug(name)`.
-- Verified by running the real generator, not by eye:
--   createSlug("Maine Pottery Tour")           -> maine-pottery-tour
--   createSlug("Fiber Festival of New England") -> fiber-festival-of-new-england
-- Both keepers carry the canonical form exactly. No drift, nothing ambiguous.
--
-- ORDER WITHIN EACH PAIR IS LOAD-BEARING: history row, re-parent, content carry,
-- THEN delete. `events.series_id` is ON DELETE SET NULL, so deleting the parent
-- first would silently orphan its children rather than failing loudly.
--
-- WHY THIS ONE ALSO MOVES CONTENT (OPE-473's did not):
--
--   `getSeriesLanding` selects `eventSeries.description` and `eventSeries.imageUrl`
--   for the hub header AND the EventSeries JSON-LD. The Maine Pottery Tour keeper
--   — the row with the GOOD slug — carries a stale operator marker as its
--   description ("[DUPLICATE — superseded by event e62cc863…]") plus
--   tags ["duplicate","merged-2026-04-21"] and a hotlinked mainemade.com image.
--   It reads that way because the backfill minted one series per event and copied
--   the event's fields; this keeper's only child is the REJECTED duplicate.
--
--   `/events/maine-pottery-tour` is 404 TODAY (the OPE-210 guard returns null for
--   a series with no public occurrence). Re-parenting the APPROVED event under it
--   turns that page 200 — so a plain re-parent would PUBLISH the duplicate marker.
--   Hence the content carry in group 1. Group 2's keeper already holds the better
--   copy (real description, better tags, venue set; both image_urls NULL), so its
--   fields are deliberately left alone.
--
-- IDEMPOTENCY: each statement is independently re-runnable. Note the history
-- INSERT takes a NOT EXISTS guard as well as the FK guard — `INSERT OR IGNORE`
-- alone is NOT idempotent here, because the id is `randomblob(16)` and there is
-- no unique constraint on (old_slug, new_slug), so a re-run would add a SECOND
-- redirect row for the same pair.
--
-- EMPTY-DATABASE SAFETY: every write is guarded on the keeper existing.
-- `series_slug_history.series_id` REFERENCES `event_series(id)`, so on CI's fresh
-- D1 an unguarded INSERT raises FOREIGN KEY constraint failed and aborts the
-- WHOLE migration run — this bit OPE-473 once already.
--
-- EXPECTED URL EFFECTS (traced through src/middleware.ts, probed live first):
--   /events/maine-pottery-tour            404 -> 200   (hub gains a live occurrence)
--   /events/maine-pottery-tour/2026       404 -> 200
--   /events/maine-pottery-tour-2026-1     200 -> 301 -> /events/maine-pottery-tour/2026
--   /events/maine-pottery-tour-2026       410 -> 410   (unchanged)
--   every fiber-festival-of-new-england URL: UNCHANGED.
-- The one 301 is EH3 P2.6 firing once the event slug no longer equals its series'
-- canonical slug — the intended occurrence shape, replacing a year-suffixed slug
-- that was never a good evergreen hub.
--
-- ROLLBACK: docs/ope490/rollback.sql (restores both parents, re-points both
-- events, restores the keeper's original content, drops the 2 redirect rows).
-- Pre-change state: docs/ope490/pre-change-series-dump.json (all 4 rows, every
-- column) and docs/ope490/pre-change-event-series-map.json.

-- ── 1. Maine Pottery Tour ────────────────────────────────────────────────────
-- keeper 0e1e7676… (maine-pottery-tour)  <-  retire 3108923d… (maine-pottery-tour-2026-1)
-- re-parents the APPROVED event e62cc863…; the keeper's existing child
-- 89c4b711… is REJECTED and stays REJECTED (410, invisible to both
-- resolveOccurrenceSlug and getSeriesLanding — each filters isPublicEventStatus).
INSERT INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '0e1e7676767e411db8f13de2c373f53d', 'maine-pottery-tour-2026-1', 'maine-pottery-tour', unixepoch(), 'ope-490'
WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '0e1e7676767e411db8f13de2c373f53d')
  AND NOT EXISTS (SELECT 1 FROM series_slug_history WHERE old_slug = 'maine-pottery-tour-2026-1' AND new_slug = 'maine-pottery-tour');

UPDATE events SET series_id = '0e1e7676767e411db8f13de2c373f53d', updated_at = unixepoch()
WHERE series_id = '3108923d4c7d956a3aa4c5f2e82f873d'
  AND EXISTS (SELECT 1 FROM event_series WHERE id = '0e1e7676767e411db8f13de2c373f53d');

-- Content carry: the live edition's copy replaces the duplicate marker.
UPDATE event_series SET
  description = 'Annual self-guided tour of Maine pottery studios, with potters across the state opening their doors to visitors for demonstrations, sales, and studio tours.',
  image_url   = 'https://cdn.meetmeatthefair.com/events/e62cc863-ce9b-4004-8039-04e208b0ef4e/image-1778118368561.jpg',
  categories  = '["Festival"]',
  tags        = '["pottery","artisan","statewide","studio-tour","spring"]',
  updated_at  = unixepoch()
WHERE id = '0e1e7676767e411db8f13de2c373f53d';

DELETE FROM event_series WHERE id = '3108923d4c7d956a3aa4c5f2e82f873d';

-- ── 2. Fiber Festival of New England ─────────────────────────────────────────
-- keeper 552356…(venued, fiber-festival-of-new-england)  <-  retire 6884cba9…
-- (venue_id NULL, fiber-festival-of-new-england-2026-1). Its only child
-- b4248709… is REJECTED, so nothing about this pair is publicly visible before
-- or after — the retiring series is already shadowed by that event at the same
-- slug (middleware's event lookup wins and 410s before the series branch runs).
-- No content carry: the keeper's own fields are strictly better.
INSERT INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '552356339b94afb0ba442aa702e68132', 'fiber-festival-of-new-england-2026-1', 'fiber-festival-of-new-england', unixepoch(), 'ope-490'
WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '552356339b94afb0ba442aa702e68132')
  AND NOT EXISTS (SELECT 1 FROM series_slug_history WHERE old_slug = 'fiber-festival-of-new-england-2026-1' AND new_slug = 'fiber-festival-of-new-england');

UPDATE events SET series_id = '552356339b94afb0ba442aa702e68132', updated_at = unixepoch()
WHERE series_id = '6884cba94c324736cecaedd4a3f9d958'
  AND EXISTS (SELECT 1 FROM event_series WHERE id = '552356339b94afb0ba442aa702e68132');

DELETE FROM event_series WHERE id = '6884cba94c324736cecaedd4a3f9d958';
