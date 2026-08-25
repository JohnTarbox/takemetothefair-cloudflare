-- OPE-483 follow-up — the six rows drizzle/0233 missed, and a correction to its
-- own read-back claim.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- The miss, and how it was found
-- ---------------------------------------------------------------------------
--
-- drizzle/0233 keyed every statement on `source_url LIKE
-- 'https://mainefairs.net/event/%'` — the dead link. Its header then offered
-- three read-back checks that must all return 0, and TWO OF THEM KEY ON
-- `source_name` INSTEAD:
--
--   SELECT COUNT(*) FROM events WHERE source_name='mainefairs.net' AND ingestion_method='annual_rollover';  -- returned 3
--   SELECT COUNT(*) FROM events WHERE sync_enabled=1 AND source_name='mainefairs.net';                      -- returned 6
--
-- So the verification was broader than the mutation it verified, and running it
-- after the deploy is what surfaced this. Recording that plainly: the read-back
-- did its job precisely BECAUSE it did not simply restate the WHERE clause. A
-- check written as the mutation's mirror image would have returned 0/0/0 and
-- confirmed nothing.
--
-- ---------------------------------------------------------------------------
-- What the six rows are
-- ---------------------------------------------------------------------------
--
-- Three fairs, each with its 2026 row and its `-me-2027` rollover:
--
--   monmouth-fair    / monmouth-fair-me-2027     source_url https://monmouthfair.com/
--   pittston-fair    / pittston-fair-me-2027     source_url https://www.pittstonfair.com
--   springfield-fair / springfield-fair-me-2027  source_url https://www.thespringfieldfair.com
--
-- They carry `source_name='mainefairs.net'` but their `source_url` is the
-- ORGANIZER's own site, alive and correct — the January scrape captured the
-- outbound link rather than the mainefairs detail page. That is why the dead-URL
-- predicate never matched them, and it is also why this migration does NOT touch
-- `source_url`: an organizer URL that resolves is exactly what OPE-483 asks for.
--
-- Two things still need fixing on them:
--
-- 1. The three `-me-2027` rows claim `source_name='mainefairs.net'` for 2027
--    dates mainefairs has never published — the same false lineage corrected on
--    the other 20 rollover rows, reached by a different route.
--
-- 2. All six carry `sync_enabled=1` against `source_name='mainefairs.net'`, and
--    `getDetailsScraper('mainefairs.net')` now resolves to a RETIRED entry
--    (the site's calendar URL 404s). The flag promises a re-sync that cannot
--    happen. Post-#1026 a run would at least report `skippedRetiredSource`
--    rather than counting it as `unchanged`, so this is no longer silent — but a
--    flag that is honestly off beats one that is loudly undeliverable.
--
-- ---------------------------------------------------------------------------
-- Idempotency, empty-db safety, rollback
-- ---------------------------------------------------------------------------
--
-- Both statements are self-limiting; after they run nothing matches. Empty-db
-- safe (plain UPDATEs, no FK-bearing INSERT). Rollback: the prior values are
-- `source_name='mainefairs.net'` and `sync_enabled=1`, both stated above, and
-- `source_url` — the only column carrying information not reconstructible from
-- this file — is deliberately untouched.
--
-- Read-back (both 0), and this time they DO match the mutations:
--
--   SELECT COUNT(*) FROM events WHERE source_name='mainefairs.net' AND ingestion_method='annual_rollover';
--   SELECT COUNT(*) FROM events WHERE sync_enabled=1 AND source_name='mainefairs.net';

-- 1. The 3 rollover rows: mainefairs never asserted these 2027 dates.
UPDATE events
SET source_name = 'auto-rollover'
WHERE source_name = 'mainefairs.net'
  AND ingestion_method = 'annual_rollover';

-- 2. All remaining mainefairs rows: the scraper the flag would drive is retired.
UPDATE events
SET sync_enabled = 0
WHERE sync_enabled = 1
  AND source_name = 'mainefairs.net';
