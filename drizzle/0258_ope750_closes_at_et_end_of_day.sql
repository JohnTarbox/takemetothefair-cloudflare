-- OPE-750 — re-anchor the nine off-convention `event_applications.closes_at`
-- rows onto the column's contract: 23:59:59 in America/New_York.
--
-- ── What was measured (prod D1, 2026-09-02) ───────────────────────────────
--
--   lane                    03:59:59Z   12:00:00Z   23:59:59Z
--   exhibitor_competition        74           0           0
--   commercial_vendor             1           8           1
--
-- 03:59:59Z is 23:59:59 EDT the previous day — the contract. The whole live
-- exhibitor lane already holds it. The nine rows below are all
-- `commercial_vendor`, all already past, and all arrived through drizzle/0257's
-- backfill of `events.application_deadline`, which is noon-anchored per OPE-307
-- (see 0257's own "Units" header: "the copy below is a straight column move").
-- That anchor is correct for a value meaning a calendar DAY and wrong for one
-- meaning a deadline instant.
--
-- ── Why it matters even though all nine are past ──────────────────────────
--
-- A noon-anchored deadline read as an instant is CLOSED from 08:00 ET on its
-- own closing morning. No visitor has been shown one — `list-entry-deadlines`
-- filters to `exhibitor_competition` and the event page excludes
-- `commercial_vendor` — but the rows are a loaded trap for the first reader
-- that widens either filter. The companion reader change
-- (`bucketEntryDeadline` now decides on the calendar day, not the instant)
-- makes the trap harmless; this makes it absent.
--
-- ── This migration is a no-op on an EMPTY database ────────────────────────
--
-- CI applies every migration to a fresh D1. Every statement is an UPDATE
-- matched on a literal id, so on an empty database each matches zero rows.
-- No INSERT, no FK reference, nothing that can abort the run.
--
-- ── Idempotent, and re-runnable ───────────────────────────────────────────
--
-- Each UPDATE carries `AND closes_at = <the old value>`. A second application
-- matches nothing. This also makes the migration refuse to move a row that
-- someone has since corrected by hand, rather than stamping over their work.
--
-- ── Rollback ──────────────────────────────────────────────────────────────
--
-- Swap the two literals in each statement: `SET closes_at = <old>` /
-- `WHERE ... AND closes_at = <new>`. The old values are recorded in this file
-- precisely so the inverse is mechanical and needs no backup to reconstruct.
--
-- ── Read-back verification ────────────────────────────────────────────────
--
--   SELECT strftime('%H:%M:%S', closes_at, 'unixepoch') tod, COUNT(*)
--   FROM event_applications WHERE closes_at IS NOT NULL GROUP BY tod;
--
-- Expected after: a single row, `03:59:59` = 84 — 74 exhibitor + 10
-- commercial. A second `tod` bucket surviving means a statement did not match,
-- which is the outcome this file is written to make visible rather than silent.
--
-- ⚠️ This line said 83 when the migration shipped, and 83 was wrong: the
-- commercial lane has TEN rows with a `closes_at` (1 already at 03:59:59, plus
-- the 8 noon and 1 UTC-EOD rows moved below), not nine. Corrected after
-- reading the post-deploy state back out of prod, which returned 84. Left as a
-- comment-only edit — the file is recorded in `d1_migrations` by FILENAME and
-- will not re-run, and on a fresh CI database every UPDATE below still matches
-- zero rows. A verification note that disagrees with the database is worse
-- than no note: the next person to run this query would read a correct result
-- as a failure.
--
-- Targets computed with Intl in America/New_York, so each keeps its own ET
-- calendar date across the EDT/EST boundary; the +57599s rows are EDT-summer
-- noon anchors and the +14400s row is the lone UTC end-of-day.

-- 2025-10-15 08:00 ET -> 2025-10-15 23:59:59 ET  (Northboro Junior Woman's Club Harvest Craft Fair 2026)
UPDATE event_applications SET closes_at = 1760587199, updated_at = unixepoch()
  WHERE id = 'cee5817d-3101-4cdd-a40f-b949f6c256df' AND closes_at = 1760529600;

-- 2026-03-26 08:00 ET -> 2026-03-26 23:59:59 ET  (Portland Fine Craft Show)
UPDATE event_applications SET closes_at = 1774583999, updated_at = unixepoch()
  WHERE id = '4433d4b6-390d-4cc0-a784-769a0cacc547' AND closes_at = 1774526400;

-- 2026-05-15 19:59:59 ET -> 2026-05-15 23:59:59 ET  (Maker Battle 2026 - Round 1; the lone UTC end-of-day)
UPDATE event_applications SET closes_at = 1778903999, updated_at = unixepoch()
  WHERE id = '9d65e823-14b5-481e-a445-b1b9a21724da' AND closes_at = 1778889599;

-- 2026-05-31 08:00 ET -> 2026-05-31 23:59:59 ET  (Trumbull Arts Festival 2026)
UPDATE event_applications SET closes_at = 1780286399, updated_at = unixepoch()
  WHERE id = '1615e6fd-f622-4b3a-a7cb-e354d388c8f4' AND closes_at = 1780228800;

-- 2026-06-03 08:00 ET -> 2026-06-03 23:59:59 ET  (Bruce Museum 45th Annual Outdoor Arts Festival 2026)
UPDATE event_applications SET closes_at = 1780545599, updated_at = unixepoch()
  WHERE id = 'c4752a5d-0b54-4767-aa1c-d2584cf85c74' AND closes_at = 1780488000;

-- 2026-06-09 08:00 ET -> 2026-06-09 23:59:59 ET  (Caravan Make It Hot Market at Allagash Brewing 2026)
UPDATE event_applications SET closes_at = 1781063999, updated_at = unixepoch()
  WHERE id = 'cac60d09-357f-49e5-a08a-9aa3192e2bf3' AND closes_at = 1781006400;

-- 2026-08-01 08:00 ET -> 2026-08-01 23:59:59 ET  (Shaker Hill Apple Festival 2026)
UPDATE event_applications SET closes_at = 1785643199, updated_at = unixepoch()
  WHERE id = '5af6e59a-b4cc-41bb-a067-eea117a8a760' AND closes_at = 1785585600;

-- 2026-08-21 08:00 ET -> 2026-08-21 23:59:59 ET  (Connecticut Renaissance Faire 2026)
UPDATE event_applications SET closes_at = 1787371199, updated_at = unixepoch()
  WHERE id = '421ba2ed-826b-4d3d-a2a3-a8a173d6bcd0' AND closes_at = 1787313600;

-- 2026-08-21 08:00 ET -> 2026-08-21 23:59:59 ET  (Arts Center East Holiday Artisan Craft Fair 2026)
UPDATE event_applications SET closes_at = 1787371199, updated_at = unixepoch()
  WHERE id = '7e1c88e1-0f03-4c79-a765-3502c5e5c650' AND closes_at = 1787313600;
