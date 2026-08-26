-- OPE-547 — rows already holding a roster, with no status recording it.
--
-- The occurred-sweep's Pass 3 keyed on `lifecycle_status = 'OCCURRED'`, so two
-- populations were never evaluated at all. Measured in prod 2026-08-26, among
-- APPROVED non-tombstoned non-farmers-market events:
--
--     past + OCCURRED ..... 499 rows,   0 with a NULL vendor_roster_status
--     past + TENTATIVE .... 126 rows, 123 with a NULL vendor_roster_status
--     upcoming ............ 483 rows, 483 with a NULL vendor_roster_status
--
-- The sweep was working perfectly on everything it could see; it could not see
-- a past TENTATIVE event, because Pass 1 only transitions SCHEDULED /
-- RESCHEDULED / MOVED_ONLINE and TENTATIVE→OCCURRED is not a legal lifecycle
-- transition anyway. The code fix widens Pass 3 rather than Pass 1.
--
-- THIS MIGRATION DOES ONE NARROW HALF OF THAT, AND DELIBERATELY NOT THE REST.
--
-- It stamps HAS_LINKS_UNVERIFIED on rows that already hold >= 10 roster-grade
-- vendor links — the "finished work with no receipt" set, 8 rows including the
-- 37-vendor Hartford CT Fall Home Show the ticket names. That determination is
-- a fact about links we hold right now, so it does not need the event to be
-- over and it does not need a promoter join.
--
-- The other ~121 past rows are NOT enqueued here. Sorting them into
-- NEEDS_RESEARCH vs NO_PUBLIC_LIST depends on `promoters.vendor_roster_
-- publishes_lists`, and re-implementing that branch in SQL would create a
-- second copy of a rule that already exists in TypeScript — the divergence
-- this ticket is itself an instance of. The widened Pass 3 picks them up on its
-- next nightly run; its per-run cap is 200 and the remaining candidate set is
-- ~131, so it drains in one pass.
--
-- HAS_LINKS_UNVERIFIED, not HAS_ROSTER. OPE-527 established the difference the
-- hard way: HAS_ROSTER is terminal, so it is never revisited, and nothing here
-- knows where these links came from. Stamping it would convert a visible gap
-- into a permanent unattributed claim that someone researched this roster.
-- 14 prod rows got that treatment once already.
--
-- vendor_roster_checked_at is deliberately NOT set: no check occurred, and a
-- timestamp would be a second claim nobody made. Likewise vendor_roster_
-- source_url stays NULL — there is no source, and inventing one is the exact
-- failure OPE-483 documented.
--
-- Idempotent: the WHERE clause requires `vendor_roster_status IS NULL`, so a
-- re-run matches nothing. Rollback: `UPDATE events SET vendor_roster_status =
-- NULL WHERE vendor_roster_status = 'HAS_LINKS_UNVERIFIED'` — safe today
-- because the status has ZERO existing rows (verified 2026-08-26), so every
-- row carrying it after this migration was put there by this migration.
--
-- Per docs/bulk-mutation-discipline.md: single-writer, idempotent,
-- read-back-verified, rollback-planned.

UPDATE events
SET vendor_roster_status = 'HAS_LINKS_UNVERIFIED',
    updated_at = unixepoch()
WHERE vendor_roster_status IS NULL
  AND merged_into IS NULL
  AND status = 'APPROVED'
  AND NOT (lower(coalesce(categories, '')) LIKE '%farmers market%')
  AND (
    SELECT COUNT(*) FROM event_vendors ev
    WHERE ev.event_id = events.id
      AND ev.status IN ('CONFIRMED', 'APPROVED')
      AND (ev.participation_type IS NULL OR ev.participation_type <> 'SPONSOR_ONLY')
  ) >= 10;

-- Read-back (run manually after deploy; NOT a mirror of the WHERE clause above
-- — OPE-483's follow-up existed because a read-back that restates the mutation
-- confirms nothing):
--
--   -- expect 8, including hartford-ct-fall-home-show-2026
--   SELECT slug, (SELECT COUNT(*) FROM event_vendors ev WHERE ev.event_id=e.id) n
--   FROM events e WHERE e.vendor_roster_status='HAS_LINKS_UNVERIFIED' ORDER BY n DESC;
--
--   -- expect 0: nothing stamped here may carry a provenance claim
--   SELECT COUNT(*) FROM events
--   WHERE vendor_roster_status='HAS_LINKS_UNVERIFIED'
--     AND (vendor_roster_checked_at IS NOT NULL OR vendor_roster_source_url IS NOT NULL);
--
--   -- expect ~121 and falling to 0 after the next occurred-sweep run
--   SELECT COUNT(*) FROM events e
--   WHERE e.vendor_roster_status IS NULL AND e.merged_into IS NULL
--     AND e.status='APPROVED'
--     AND NOT (lower(coalesce(e.categories,'')) LIKE '%farmers market%')
--     AND e.end_date IS NOT NULL AND e.end_date < unixepoch();
