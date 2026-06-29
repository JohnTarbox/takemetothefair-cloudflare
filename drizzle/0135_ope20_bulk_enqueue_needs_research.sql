-- OPE-20 (2026-06-29) — one-time bulk enqueue of ALL unevaluated occurred
-- events into the vendor-roster NEEDS_RESEARCH queue.
--
-- The OPE-15 occurred-trigger (event-occurred-sweep Pass 3) only enqueues
-- events as they NEWLY transition to OCCURRED, capped at 200/run. It does not
-- backfill the historical OCCURRED corpus in one shot, so the analyst drain
-- (OPE-14) would otherwise wait days for the cron to seed the backlog 200 at a
-- time. This migration seeds the whole backlog at once.
--
-- SCOPE (widened by John 2026-06-29T17:11Z): ALL occurred events with no roster
-- status yet — NOT class-filtered. Producer-class prioritization lives on the
-- DRAIN side (OPE-14's playbook), so the queue carries everything and the drain
-- picks producer-class + recent-by-end-date first.
--
-- This is the SAME write Pass 3 already performs (NULL -> NEEDS_RESEARCH, and a
-- matching updated_at bump), just unbounded and run once — so it introduces no
-- new behavior, only does sooner what the daily cron would do over many days.
--
-- SAFETY / idempotency:
--   * Non-destructive: only flips vendor_roster_status from NULL. Researched
--     terminal states (HAS_ROSTER / NO_PUBLIC_LIST / PARTIAL) are guarded by
--     `IS NULL` and never touched.
--   * Only lifecycle_status='OCCURRED' — future/in-progress events have no
--     roster to mine yet and are excluded.
--   * Idempotent: wrangler applies a migration exactly once; the `IS NULL`
--     guard also makes a manual re-run a 0-row no-op.
--
-- AUDIT: the admin_actions row below is written BEFORE the UPDATE, capturing the
-- exact pre-mutation COUNT(*) via subquery — so the count is recorded in prod at
-- apply time (this runtime can't read prod D1 to pre-surface it in the PR). The
-- count is also re-derivable post-hoc as the number of NEEDS_RESEARCH rows whose
-- vendor_roster_checked_at IS NULL.

-- STEP 1 — audit row capturing the pre-mutation count (no actor; system-driven).
INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
VALUES (
  lower(hex(randomblob(16))),
  'event.vendor_roster_bulk_enqueue',
  NULL,
  'system',
  'OPE-20',
  json_object(
    'task', 'OPE-20',
    'description', 'One-time bulk enqueue of all unevaluated OCCURRED events to NEEDS_RESEARCH',
    'class_filter', 'none',
    'via', 'migration/0135',
    'enqueued_count', (
      SELECT COUNT(*) FROM events
      WHERE vendor_roster_status IS NULL
        AND lifecycle_status = 'OCCURRED'
    )
  ),
  unixepoch('now')
);

-- STEP 2 — the bulk enqueue. Mirrors event-occurred-sweep Pass 3's write.
UPDATE events
SET vendor_roster_status = 'NEEDS_RESEARCH',
    updated_at = unixepoch('now')
WHERE vendor_roster_status IS NULL
  AND lifecycle_status = 'OCCURRED';
