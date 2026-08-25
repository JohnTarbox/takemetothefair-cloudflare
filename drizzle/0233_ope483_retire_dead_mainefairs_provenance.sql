-- OPE-483 — retire the dead mainefairs.net provenance on 35 event rows.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- What is actually broken (all three re-verified 2026-08-25)
-- ---------------------------------------------------------------------------
--
-- 1. The per-event URL pattern is gone. `https://mainefairs.net/event/<slug>/`
--    returns 404 for all 35 stored URLs. The site root still 200s.
--
-- 2. The SCRAPER is dead at its entry point, not just at the leaves.
--    `src/lib/scrapers/mainefairs.ts` fetches
--    `CALENDAR_URL = https://mainefairs.net/fairs/fair-calendar/` → 404, and
--    parses `tribe-events-calendar-list__event-title-link` anchors that the
--    rebuilt site no longer emits. So a re-sync could not succeed even if one
--    were attempted. This is why `sync_enabled` is cleared below rather than
--    wired to a cadence: wiring a schedule to a scraper whose first fetch 404s
--    would produce a job that runs, fails, and reports nothing — strictly worse
--    than a flag that is honestly off.
--
-- 3. Nothing schedules a re-sync anyway. `sync_enabled` is read in exactly one
--    place, `PATCH /api/admin/import` (src/app/api/admin/import/route.ts), which
--    is an on-demand admin endpoint. No cron dispatches to it: the MCP Worker's
--    triggers are "0 6 * * *", "10 6 * * *", "*/10 * * * *", "0 * * * *",
--    "0 7 * * *", "0 8 * * *", "30 8 * * *", "0 11 * * 1", and none routes there.
--    The ticket said the flag "drives nothing"; more precisely, it drives a real
--    handler that nothing calls.
--
-- ---------------------------------------------------------------------------
-- The two cohorts are different lies and get different repairs
-- ---------------------------------------------------------------------------
--
--   20 rows  ingestion_method='annual_rollover', created 2026-06-15 14:37:59
--   14 rows  ingestion_method='direct_scrape',   created 2026-01-27 20:11 (live)
--    1 row   a merged tombstone — excluded, it 301s and renders nothing
--
-- For the JANUARY cohort, `source_name='mainefairs.net'` is TRUE: mainefairs
-- really was where those 2026 dates came from. Only the URL is a lie, so only
-- the URL is removed. The lineage label stays.
--
-- For the ROLLOVER cohort it is FALSE. Those are 2027 editions computed from the
-- 2026 rows by an offline script five months AFTER the URL pattern died;
-- mainefairs has never published a 2027 date for any of them. Both the URL and
-- the source_name are corrected, to the same `auto-rollover` label the in-repo
-- rollover path now writes (mcp-server/src/event-rollover.ts, this PR).
--
-- ---------------------------------------------------------------------------
-- Why NULL rather than the organizer's own site
-- ---------------------------------------------------------------------------
--
-- The ticket prefers repointing at the organizer, and that is the right end
-- state — but it cannot be done safely by rule, only by row. We hold organizer
-- URLs for most of these fairs (`promoters.website`, `events.ticket_url`), and a
-- bulk copy would have been one statement. It would also have been wrong at
-- least once: `common-ground-fair` carries `ticket_url = farmingtonfair.org`.
-- Common Ground is MOFGA's fair, not Farmington's. Copying that into
-- `source_url` would mint a citation asserting that farmingtonfair.org is the
-- source for a fair it has nothing to do with — a fabricated provenance claim,
-- which is a worse defect than the dead link it replaces.
--
-- NULL says "we do not have a receipt for this", which is the true statement.
-- A 404 says "here is the receipt" and cannot be followed, which is why it is
-- worse than nothing: it makes the claim unfalsifiable while looking sourced.
--
-- Repointing at verified organizer sources is left to the citation backfill,
-- which is per-row research against live pages — see the ticket.
--
-- ---------------------------------------------------------------------------
-- Idempotency, empty-db safety, and rollback
-- ---------------------------------------------------------------------------
--
-- Every statement keys on `source_url LIKE 'https://mainefairs.net/event/%'` and
-- clears that column, so after the run nothing matches and a replay is a no-op.
--
-- Empty-db safe: plain UPDATEs with a WHERE and no FK-bearing INSERT, so they
-- match zero rows on the fresh D1 CI builds from migrations.
--
-- Rollback: the removed values are fully reconstructible without a restore —
-- every one was `https://mainefairs.net/event/<event slug minus any -me-YYYY
-- suffix>/`, and all 35 are enumerated in the ticket. Nothing else is touched.
--
-- Read-back verification (all three must be 0 / 0 / 0):
--
--   SELECT COUNT(*) FROM events WHERE source_url LIKE 'https://mainefairs.net/event/%';
--   SELECT COUNT(*) FROM events WHERE source_name='mainefairs.net' AND ingestion_method='annual_rollover';
--   SELECT COUNT(*) FROM events WHERE sync_enabled=1 AND source_name='mainefairs.net';

-- 1. Rollover cohort: mainefairs never asserted these 2027 dates. Correct the
--    label to match what the in-repo rollover path now writes, and drop the URL.
UPDATE events
SET source_name = 'auto-rollover',
    source_url = NULL,
    sync_enabled = 0
WHERE source_url LIKE 'https://mainefairs.net/event/%'
  AND ingestion_method = 'annual_rollover';

-- 2. January cohort (and the tombstone, harmlessly): the aggregator lineage is
--    real, so `source_name` stays. Only the unfollowable URL goes, and the flag
--    that promises a re-sync no living scraper can perform.
UPDATE events
SET source_url = NULL,
    sync_enabled = 0
WHERE source_url LIKE 'https://mainefairs.net/event/%';

-- `source_domain` is deliberately left as-is on the January cohort: those rows
-- DID come from mainefairs.net, and the column records which source tier the
-- data carries (it feeds AGGREGATOR_HOSTS reliability scoring). Removing it
-- would erase a true fact to tidy up a false one. The rollover cohort already
-- has source_domain NULL, which was correct by accident.
--
-- `updated_at` is not bumped: this corrects provenance metadata, changes no
-- rendered value, and a bump would invalidate ETags and emit syndication diffs
-- for 35 events whose public content is unchanged.
