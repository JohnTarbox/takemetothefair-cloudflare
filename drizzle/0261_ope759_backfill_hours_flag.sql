-- OPE-759 — raise `flagged_for_review` on the events whose hours were never
-- flagged, because four of the five `event_days` writers never maintained it.
--
-- ── Which half this is ────────────────────────────────────────────────────
--
-- The FALSE NEGATIVES only: `flagged_for_review = 0` while at least one day
-- lacks an open or close time. Measured 2026-09-02 over 559 APPROVED unmerged
-- events that have at least one day row:
--
--   flag  hours state                events
--   0     all days have both times   502   <- the flag works, and normally does
--   0     some day missing a time      9   <- THIS migration
--   1     all days have both times     10   <- NOT touched, see below
--   1     some day missing a time      38   <- already correct
--
-- Seven of the nine have `n_unknown = n_days` — every day hourless — which is
-- the signature of a bulk writer that never flagged, not of a clear that
-- misfired.
--
-- ── Why the ten false POSITIVES are deliberately left alone ───────────────
--
-- Clearing them would require deciding that hours are the only reason each is
-- flagged, and that is undecidable from the data: `flagged_for_review` is one
-- boolean carrying several independent reasons, and nothing records which
-- applies. It is also set by a new series occurrence
-- (`create-occurrence.ts:249`), a URL import (`import-url/route.ts:418`) and an
-- annual rollover (`event-rollover.ts:254`).
--
-- So a "recompute" here would silently discharge review obligations that have
-- nothing to do with hours. Routed to John as a design decision instead.
-- Over-flagging costs a reviewer one look; under-flagging costs a visitor a
-- wrong answer — the asymmetry is why this direction ships and the other does
-- not.
--
-- ── Empty-database safety ─────────────────────────────────────────────────
--
-- A single UPDATE with an EXISTS subquery. On a fresh CI database it matches
-- zero rows and inserts nothing. No FK reference, nothing that can abort.
--
-- ── Idempotent ────────────────────────────────────────────────────────────
--
-- `flagged_for_review = 0` is in the WHERE, so a second application matches
-- nothing. It is also monotonic: re-running can never lower a flag.
--
-- ── Read-back verification ────────────────────────────────────────────────
--
--   SELECT COUNT(*) FROM events e
--   WHERE e.status='APPROVED' AND e.merged_into IS NULL
--     AND e.flagged_for_review = 0
--     AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id
--                  AND (d.open_time IS NULL OR d.close_time IS NULL));
--
-- Expected after: 0.
--
-- ⚠️ And the landmark, because a zero that was never able to be non-zero is
-- not evidence (OPE-6 v3.8). Run alongside it:
--
--   SELECT COUNT(*) FROM events e WHERE e.status='APPROVED'
--     AND e.merged_into IS NULL
--     AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id);
--
-- That denominator was 559 when this was written. A 0 against a 559 means the
-- cell is empty; a 0 against a 0 means the query stopped selecting anything.

UPDATE events
SET flagged_for_review = 1,
    updated_at = unixepoch()
WHERE status = 'APPROVED'
  AND merged_into IS NULL
  AND flagged_for_review = 0
  AND EXISTS (
    SELECT 1 FROM event_days d
    WHERE d.event_id = events.id
      AND (d.open_time IS NULL OR d.close_time IS NULL)
  );
