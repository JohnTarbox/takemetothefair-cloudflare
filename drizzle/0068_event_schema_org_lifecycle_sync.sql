-- Backfill event_schema_org.schema_event_status from events.lifecycle_status.
--
-- The cache column was added with 0042 and has been ~96% null in prod (359
-- of 373 rows) since: it was only ever populated by URL-import and the
-- manual schema-org sync workflow. Neither path regenerates on
-- events.status changes. Post-PR-#157 (lifecycle migration 0067), the
-- lifecycle column is the source of truth, so this migration syncs the
-- cache to match.
--
-- Idempotent guard: only update rows where the cache is null OR currently
-- says EventScheduled. Rows that already hold a non-Scheduled value were
-- populated from external JSON-LD fetched at URL-import time — that's
-- richer provenance than our internal lifecycle, so we don't clobber.
--
-- OCCURRED and NO_SHOW deliberately leave the cache value alone (the
-- ELSE branch). Schema.org has no equivalent for past events with
-- known/unknown occurrence; emitting EventScheduled for a past event
-- would mislead crawlers. EventSchema.tsx now omits eventStatus
-- entirely for these states.
--
-- See plan doc /home/wa1kli/.claude/plans/please-plan-all-of-harmonic-petal.md
-- Migration added 2026-05-13.

UPDATE event_schema_org
SET schema_event_status = CASE (
  SELECT lifecycle_status FROM events WHERE events.id = event_schema_org.event_id
)
  WHEN 'SCHEDULED' THEN 'https://schema.org/EventScheduled'
  WHEN 'TENTATIVE' THEN 'https://schema.org/EventScheduled'
  WHEN 'POSTPONED' THEN 'https://schema.org/EventPostponed'
  WHEN 'RESCHEDULED' THEN 'https://schema.org/EventRescheduled'
  WHEN 'CANCELLED' THEN 'https://schema.org/EventCancelled'
  WHEN 'MOVED_ONLINE' THEN 'https://schema.org/EventMovedOnline'
  ELSE schema_event_status
END
WHERE schema_event_status IS NULL
   OR schema_event_status = 'https://schema.org/EventScheduled';
