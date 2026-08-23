-- OPE-525 — backfill the events the occurred-sweep stamped NEEDS_RESEARCH
-- while they already held an ingested exhibitor list.
--
-- The sweep selected on `vendor_roster_status IS NULL` and trusted a downstream
-- research worker (a skill in another repo) to skip populated events. It did
-- not, so 34 OCCURRED events carrying 1,440 CONFIRMED/APPROVED vendor links
-- were queued as unresearched and the weekly drain re-surfaced them
-- indefinitely. The sweep guard that stops this recurring ships in the same PR;
-- because the sweep only ever touches NULL rows, it will never revisit these,
-- so they need a one-time correction.
--
-- Scope is deliberately NARROWER than "every event with links":
--
--   * >= 10 non-sponsor links only. Of the 34 rows, 15 carried >=10 and held
--     1,396 of the 1,440 links (97%); the other 19 held 44 between them, 13 of
--     those three or fewer. Two vendors is not a roster, and re-surfacing those
--     for research is CORRECT — stamping them here to drive an audit query to
--     zero would make the data worse, not better.
--   * SPONSOR_ONLY excluded. Three of the 34 had sponsors as their ONLY links.
--     A sponsor is not a vendor roster; counting them would assert we hold a
--     roster we have never held, and permanently drop the event from research.
--
-- Idempotent: after the first run these rows no longer match
-- `vendor_roster_status = 'NEEDS_RESEARCH'`, so a re-apply matches nothing.
-- No-ops on an empty database (CLAUDE.md: CI applies every migration to a fresh
-- D1) — the WHERE simply selects no rows, and nothing here depends on an FK.
--
-- Rollback:
--   UPDATE events SET vendor_roster_status = 'NEEDS_RESEARCH',
--                     vendor_roster_checked_at = NULL
--    WHERE vendor_roster_status = 'HAS_ROSTER'
--      AND vendor_roster_source_url IS NULL
--      AND vendor_roster_checked_at = <this migration's stamp>;
--
-- vendor_roster_source_url is deliberately left NULL: we are asserting "these
-- links exist", not "this page is where they came from". set_vendor_roster_status
-- already warns on a null source_url rather than inventing one, and that warning
-- is the honest signal here.

UPDATE events
   SET vendor_roster_status   = 'HAS_ROSTER',
       vendor_roster_checked_at = unixepoch(),
       updated_at             = unixepoch()
 WHERE vendor_roster_status = 'NEEDS_RESEARCH'
   AND lifecycle_status     = 'OCCURRED'
   AND merged_into IS NULL
   AND (
         SELECT COUNT(*)
           FROM event_vendors ev
          WHERE ev.event_id = events.id
            AND ev.status IN ('CONFIRMED', 'APPROVED')
            AND (ev.participation_type IS NULL
                 OR ev.participation_type <> 'SPONSOR_ONLY')
       ) >= 10;
