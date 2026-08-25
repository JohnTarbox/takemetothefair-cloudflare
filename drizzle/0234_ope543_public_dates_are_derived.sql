-- OPE-543 — make `public_start_date`/`public_end_date` mean exactly one thing.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- What the column is (the question the ticket asked and could not answer)
-- ---------------------------------------------------------------------------
--
-- The ticket asked whether `public_*` is a writable override or a denormalized
-- mirror of `start_date`/`end_date`, and marked its own mechanism UNVERIFIED for
-- want of repo access. Read from the source, the answer is: NEITHER, and that is
-- the defect. It is a DERIVED value — "the first and last day the PUBLIC can
-- attend" — computed by `computePublicDates()` (src/lib/utils.ts) as the
-- event_days span minus `vendor_only` setup days. It legitimately differs from
-- `start_date` exactly when an event has vendor-only days.
--
-- But two code paths gave it a second, incompatible meaning:
--
--   * every CREATE path wrote `public_* = start/end` when the event had no
--     event_days — a denormalized COPY;
--   * and `public_*` was only ever RECOMPUTED by the event_day write paths.
--
-- A copy that nothing invalidates. Change `start_date` without touching
-- event_days — which is what `update_event` does — and the copy stays behind,
-- and the public page keeps serving it.
--
-- ---------------------------------------------------------------------------
-- Why this is not a cosmetic drift
-- ---------------------------------------------------------------------------
--
-- The renderer serves `start_date` to admins and vendors and `public_*` to
-- everyone else (src/app/events/[slug]/page.tsx:1156-1167). So the divergence is
-- invisible to precisely the people who could fix it: an admin opening the page
-- sees the correct date; only the public sees the wrong one. The reporter found
-- it only by checking the served page as an anonymous visitor.
--
-- Specimen: `great-feast-of-the-holy-ghost-of-new-england-2026` rendered a band
-- of "Thu, Aug 27, 2026 - Sun, Aug 30, 2026" while its own schedule list, its
-- "Next:" line and its og:description — same page, same fetch — all said Aug 26.
--
-- ---------------------------------------------------------------------------
-- Scope — measured against production 2026-08-25
-- ---------------------------------------------------------------------------
--
--   905  live rows carry a non-NULL public_start_date
--   326  of them have NO event_days at all  → every one is an uninvalidated copy
--     4  have event_days but a public_start_date that disagrees with them
--    10  have vendor-only days, where divergence is CORRECT and must survive
--
-- The ticket sized the problem at 49 rows (57 by the time this ran) because it
-- counted only rows already diverging. That undercounts: the other ~289 copies
-- agree with start_date today purely because nobody has corrected their date
-- yet. Each is the same defect waiting for its first edit. Statement 1 therefore
-- clears all 326, not just the ones that have already gone wrong.
--
-- ---------------------------------------------------------------------------
-- Why NULL, and why that loses nothing
-- ---------------------------------------------------------------------------
--
-- With no event_days there is no public span to derive, so NULL is the honest
-- value — and it is already what the correctly-rendering rows look like (the
-- reporter noted Brooklyn Fair and Terryville render right, both with
-- `public_start_date IS NULL`).
--
-- Verified before writing: EVERY reader is `publicStartDate ?? startDate` —
-- event-card.tsx:111, events/[slug]/page.tsx:1163, events-view.tsx:1303,
-- StubEventCard.tsx:53 — and NO query anywhere orders or filters on the column.
-- So nulling a copy that equals start_date changes no rendered output at all;
-- the only visible change is the 37 rows whose copy had gone stale, which start
-- rendering their true dates.
--
-- ---------------------------------------------------------------------------
-- Idempotency, empty-db safety, and rollback
-- ---------------------------------------------------------------------------
--
-- Both statements are convergent, not incremental: they set the column to what
-- the derivation says it should be, so re-running is a no-op and running them in
-- either order gives the same result. Safe to replay.
--
-- Empty-db safe: plain UPDATEs with a WHERE, no FK-bearing INSERT, so they match
-- zero rows on the fresh D1 CI builds from migrations.
--
-- Rollback: nothing is lost that is not recomputable. Statement 1 clears values
-- that were copies of columns still present on the same row; statement 2 sets
-- values derived from `event_days`, which is untouched. Re-deriving is the
-- migration itself.
--
-- Read-back verification (both must be 0):
--
--   -- no public_* without days to derive it from
--   SELECT COUNT(*) FROM events e WHERE e.merged_into IS NULL
--     AND e.public_start_date IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id);
--
--   -- and where there are days, public_* matches them
--   SELECT COUNT(*) FROM events e WHERE e.merged_into IS NULL
--     AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id)
--     AND IFNULL(date(e.public_start_date,'unixepoch'),'~') <>
--         IFNULL((SELECT MIN(d.date) FROM event_days d
--                 WHERE d.event_id = e.id AND d.vendor_only = 0),'~');
--
-- The same two checks run continuously as `public_date_derivation` in
-- `get_data_health_report`, so a writer that reintroduces a copy is visible
-- without anyone remembering to re-run this.

-- 1. No event_days → nothing to derive a public span from → NULL.
UPDATE events
SET public_start_date = NULL,
    public_end_date = NULL
WHERE merged_into IS NULL
  AND (public_start_date IS NOT NULL OR public_end_date IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = events.id);

-- 2. Has event_days → re-derive from them, honouring vendor_only.
--    MIN/MAX over the non-vendor-only days is exactly what `computePublicDates`
--    computes; when every day is vendor-only both aggregates are NULL, which is
--    also what the helper returns. Noon anchor, per drizzle/0232 and OPE-307.
UPDATE events
SET public_start_date = (
      SELECT unixepoch(MIN(d.date) || ' 12:00:00') FROM event_days d
      WHERE d.event_id = events.id AND d.vendor_only = 0
    ),
    public_end_date = (
      SELECT unixepoch(MAX(d.date) || ' 12:00:00') FROM event_days d
      WHERE d.event_id = events.id AND d.vendor_only = 0
    )
WHERE merged_into IS NULL
  AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = events.id);

-- `updated_at` is not bumped. For the ~289 rows whose copy already agreed with
-- start_date this changes no rendered value, and bumping would invalidate every
-- ETag (OPE-308/OPE-332) and emit a syndication diff for a no-op.
