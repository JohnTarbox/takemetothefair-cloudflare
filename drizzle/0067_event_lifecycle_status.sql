-- Event lifecycle status — adds an orthogonal axis to `events.status` so
-- "is this approved for public display" (editorial) is separable from
-- "what's actually happening with this event" (real-world).
--
-- Today the single `status` column conflates the two: TENTATIVE encodes
-- "dates not confirmed" (a lifecycle concept) and CANCELLED encodes a
-- real-world state both bolted onto the editorial workflow. After this
-- migration:
--
--   * status stays editorial: DRAFT/PENDING/APPROVED/REJECTED. CANCELLED
--     remains in the enum for backward compat but is discouraged for new
--     writes — normalize through lifecycle_status instead.
--   * lifecycle_status carries: SCHEDULED / TENTATIVE / POSTPONED /
--     RESCHEDULED / CANCELLED / OCCURRED / MOVED_ONLINE / NO_SHOW. The
--     first five map 1:1 to schema.org Event status URIs; OCCURRED,
--     NO_SHOW, TENTATIVE are MMATF additions for past-event semantics
--     and dates-not-yet-confirmed.
--
-- Public visibility going forward = editorial APPROVED AND lifecycle NOT
-- IN (CANCELLED, NO_SHOW). The legacy PUBLIC_EVENT_STATUSES check stays in
-- place during the transition; publicEventWhere() in
-- src/lib/event-lifecycle.ts is the new combined gate.
--
-- Backfill strategy is conservative and idempotent (every UPDATE has a
-- `WHERE lifecycle_status = 'SCHEDULED'` guard so re-runs are safe):
--
--   editorial CANCELLED              → lifecycle CANCELLED
--   editorial TENTATIVE              → lifecycle TENTATIVE
--   editorial APPROVED, end < now    → lifecycle OCCURRED  (~545 rows)
--   editorial APPROVED, dates_confirmed = 0 → lifecycle TENTATIVE
--   everything else                  → lifecycle SCHEDULED (column default)
--
-- The OCCURRED backfill is aggressive — promoters who left their listing
-- APPROVED through the event date are assumed to have held it. A new
-- recommendation rule `confirm_past_event_occurrence` (PR 2) will queue
-- these for admin sanity-check; manual flip to NO_SHOW is supported via
-- the lifecycle PATCH endpoint.
--
-- See plan doc /home/wa1kli/.claude/plans/please-plan-all-of-harmonic-petal.md
-- Migration added 2026-05-13.

ALTER TABLE events ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE events ADD COLUMN lifecycle_status_changed_at INTEGER;
ALTER TABLE events ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE events ADD COLUMN previous_start_date INTEGER;
ALTER TABLE events ADD COLUMN previous_end_date INTEGER;

UPDATE events SET lifecycle_status = 'CANCELLED'
  WHERE status = 'CANCELLED' AND lifecycle_status = 'SCHEDULED';

UPDATE events SET lifecycle_status = 'TENTATIVE'
  WHERE status = 'TENTATIVE' AND lifecycle_status = 'SCHEDULED';

UPDATE events SET lifecycle_status = 'OCCURRED'
  WHERE status = 'APPROVED' AND lifecycle_status = 'SCHEDULED'
    AND end_date IS NOT NULL AND end_date < strftime('%s', 'now');

UPDATE events SET lifecycle_status = 'TENTATIVE'
  WHERE status = 'APPROVED' AND lifecycle_status = 'SCHEDULED'
    AND dates_confirmed = 0;

CREATE INDEX idx_events_lifecycle_status ON events(lifecycle_status);
