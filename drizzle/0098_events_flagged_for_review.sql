-- UX-R1 / C1 (analyst, 2026-06-01 EVE): events.flagged_for_review marker.
--
-- Set by scripts/backfill-event-days-from-description.ts when expandCadence()
-- can't determine a recurrence pattern from the event description. The row
-- stays as its original date range (start_date → end_date) but is queued for
-- operator review at /admin/events?flagged=1. Mirrors the K7 pattern from
-- inbound_emails.flagged_for_review (drizzle/<earlier>) — "only SET the
-- flag here — never clear it" — operators clear after triage.
--
-- Distinct from events.gate_flags (pre-existing JSON column populated by
-- evaluateGates() on ingest). gate_flags is a pre-ingest decision trace;
-- flagged_for_review is a post-ingest operator-action queue.
--
-- Partial index matches the inbound_emails.flagged_for_review pattern at
-- packages/db-schema/src/index.ts:1564 — only the "1" rows go into the
-- index, keeping it small (operator queue is always a small subset).
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('events'); -- confirm flagged_for_review NOT present
-- Verified 2026-06-01 EVE via Cloudflare MCP d1_database_query: only
-- gate_flags exists; flagged_for_review is new.

ALTER TABLE events ADD COLUMN flagged_for_review INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_flagged_for_review
  ON events(flagged_for_review)
  WHERE flagged_for_review = 1;
