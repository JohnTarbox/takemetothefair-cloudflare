-- Pre-ingest date-quality gate trace column. Added with the gates rolled out
-- in PR (analyst backlog item #1, 2026-05-16). When evaluateGates() in
-- src/lib/event-date-gates.ts routes an incoming event to PENDING_REVIEW,
-- the ingest path stores the firing reasons as a JSON array of short
-- codes in this column so the admin can see WHY the event was held.
--
-- Format: JSON array of strings, e.g.
--   ["source_tier_3_aggregator", "start_equals_deadline"]
--
-- NULL = gate did not fire OR row predates the gates. The recommendations
-- engine's event_date_drift rule reads this column to surface "PENDING due
-- to gate flag" items for admin triage.
--
-- See plan doc /home/wa1kli/.claude/plans/please-plan-all-of-harmonic-petal.md
-- Migration added 2026-05-16.

ALTER TABLE events ADD COLUMN gate_flags TEXT;
