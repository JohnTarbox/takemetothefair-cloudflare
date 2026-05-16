-- Periodic re-verification cron output. Stores drift between
-- events.start_date (what we have stored) and the canonical date fetched
-- from events.source_url. Drives the event_date_drift recommendation card.
--
-- Sweep cadence: daily 6 AM UTC via the MCP worker's scheduled handler.
-- Sweep scope: APPROVED events with start_date 30-90 days in the future
-- and a non-null source_url.
--
-- UNIQUE (event_id, stored_start_date) — re-runs against an unchanged
-- (event, date) pair are idempotent. If start_date later gets corrected
-- via the lifecycle endpoint, the next sweep can record fresh drift
-- against the new stored value without conflicting.
--
-- See plan doc /home/wa1kli/.claude/plans/please-plan-all-of-harmonic-petal.md
-- Migration added 2026-05-16.

CREATE TABLE event_date_drift_findings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  stored_start_date INTEGER NOT NULL,
  canonical_start_date INTEGER,
  drift_days INTEGER NOT NULL,
  canonical_url TEXT,
  canonical_html_excerpt TEXT,
  checked_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (event_id, stored_start_date)
);

CREATE INDEX idx_event_date_drift_findings_event_id ON event_date_drift_findings(event_id);
CREATE INDEX idx_event_date_drift_findings_resolved_at ON event_date_drift_findings(resolved_at);
