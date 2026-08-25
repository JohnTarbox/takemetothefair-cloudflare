-- OPE-482 — re-anchor every midnight-UTC event date to the 12:00Z anchor, so the
-- display layer can switch from UTC to America/New_York without shifting them.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- Why this has to land BEFORE the formatter flip, not beside it
-- ---------------------------------------------------------------------------
--
-- The same PR points the date-only formatters at America/New_York. That is
-- correct for every storage convention in the corpus EXCEPT one:
--
--   time-of-day (UTC)   meaning                          UTC render   ET render
--   12:00:00Z           canonical anchor                 ✅            ✅
--   03:59:59Z           23:59:59 Eastern, end of day     ❌ +1 day     ✅
--   00:15–03:00Z        real Eastern closing times       ❌ +1 day     ✅
--   04:00:00Z           midnight Eastern (EST half)      ❌ +1 day     ✅
--   00:00:00Z           "this calendar date" literally   ✅            ❌ −1 day
--
-- Flipping the formatter without this migration swaps 43 dates that are one day
-- LATE for a larger set that are one day EARLY. A day early is the worse error:
-- on `application_deadline` it tells a vendor they missed a deadline they had
-- not, and on `public_start_date` it is the date every event CARD renders
-- (`event.publicStartDate ?? event.startDate`, event-card.tsx:111).
--
-- ---------------------------------------------------------------------------
-- Scope — measured against production 2026-08-25, `merged_into IS NULL`
-- ---------------------------------------------------------------------------
--
--   start_date           30 rows
--   end_date             25 rows
--   public_start_date   695 rows
--   public_end_date     698 rows
--   application_deadline 12 rows
--
-- The ticket sized this at 20 rows because it measured `start_date`/`end_date`
-- on APPROVED events only. `public_start_date`/`public_end_date` are the columns
-- that actually feed the rendered band and they are two orders of magnitude
-- worse, so they are in scope here or the formatter flip is a regression.
--
-- Not restricted by `status`: a PENDING row approved next week would otherwise
-- reintroduce the defect on a page nobody re-checked. Merged tombstones ARE
-- excluded — they 301 to their keeper and render nothing.
--
-- ---------------------------------------------------------------------------
-- Why noon, and why this loses no information
-- ---------------------------------------------------------------------------
--
-- 12:00Z is 07:00/08:00 ET, so the Eastern calendar date and the UTC calendar
-- date agree — the anchor is timezone-safe in BOTH directions, which is exactly
-- the property 00:00:00Z lacks. It is the anchor `normalizeEventDate` has
-- applied at ingest since OPE-307 and the one drizzle/0199 used for the
-- start_date half of this corpus.
--
-- Each statement preserves `date(<col>,'unixepoch')` — the UTC calendar date is
-- unchanged, only the time-of-day moves. A 00:00:00Z value carries no real
-- time-of-day to lose: it is the signature of a date-only ingest that bypassed
-- normalizeEventDate (per the A3/K14 gate note, the intended date IS the UTC
-- date). Real opening/closing hours live in `event_days.open_time`/`close_time`,
-- which this migration does not touch.
--
-- ---------------------------------------------------------------------------
-- Idempotency, empty-db safety, and rollback
-- ---------------------------------------------------------------------------
--
-- Each statement is self-limiting: after it runs no row matches its WHERE
-- clause, so a re-run is a no-op. Safe to replay.
--
-- Empty-db safe: these are plain UPDATEs with a WHERE and no FK-bearing INSERT,
-- so they match zero rows on the fresh D1 that CI builds from migrations and
-- cannot abort the run.
--
-- Rollback: no undo beyond a D1 point-in-time restore. Accepted because the
-- change is confined to the time-of-day component of values that carried no
-- meaningful time-of-day, and the UTC calendar date — the part anything
-- downstream keys on — is provably preserved by the expression itself.
--
-- Read-back verification (run after apply; every count must be 0):
--
--   SELECT
--     SUM(strftime('%H:%M:%S',start_date,'unixepoch')='00:00:00')           s,
--     SUM(strftime('%H:%M:%S',end_date,'unixepoch')='00:00:00')             e,
--     SUM(strftime('%H:%M:%S',public_start_date,'unixepoch')='00:00:00')    ps,
--     SUM(strftime('%H:%M:%S',public_end_date,'unixepoch')='00:00:00')      pe,
--     SUM(strftime('%H:%M:%S',application_deadline,'unixepoch')='00:00:00') ad
--   FROM events WHERE merged_into IS NULL;
--
-- The same check runs continuously as `midnightUtcDateAnchors` in
-- `get_data_health_report`, so a writer that reintroduces the convention is
-- visible without anyone remembering to re-run this.

-- 1. events.start_date
UPDATE events
SET start_date = unixepoch(date(start_date, 'unixepoch') || ' 12:00:00')
WHERE merged_into IS NULL
  AND start_date IS NOT NULL
  AND strftime('%H:%M:%S', start_date, 'unixepoch') = '00:00:00';

-- 2. events.end_date
UPDATE events
SET end_date = unixepoch(date(end_date, 'unixepoch') || ' 12:00:00')
WHERE merged_into IS NULL
  AND end_date IS NOT NULL
  AND strftime('%H:%M:%S', end_date, 'unixepoch') = '00:00:00';

-- 3. events.public_start_date — the column the event card actually renders
UPDATE events
SET public_start_date = unixepoch(date(public_start_date, 'unixepoch') || ' 12:00:00')
WHERE merged_into IS NULL
  AND public_start_date IS NOT NULL
  AND strftime('%H:%M:%S', public_start_date, 'unixepoch') = '00:00:00';

-- 4. events.public_end_date
UPDATE events
SET public_end_date = unixepoch(date(public_end_date, 'unixepoch') || ' 12:00:00')
WHERE merged_into IS NULL
  AND public_end_date IS NOT NULL
  AND strftime('%H:%M:%S', public_end_date, 'unixepoch') = '00:00:00';

-- 5. events.application_deadline — a day early here is a missed-deadline claim
UPDATE events
SET application_deadline = unixepoch(date(application_deadline, 'unixepoch') || ' 12:00:00')
WHERE merged_into IS NULL
  AND application_deadline IS NOT NULL
  AND strftime('%H:%M:%S', application_deadline, 'unixepoch') = '00:00:00';

-- `updated_at` is deliberately NOT bumped. It is a change signal read by the
-- conditional-GET/ETag path (OPE-308/OPE-332) and by the syndication diff; a
-- 700-row bump would invalidate every one of those caches and emit a spurious
-- "changed" event for a correction that alters no rendered value on the
-- already-correct rows. drizzle/0199 did bump it, on 32 rows — a scale where
-- that was harmless.
