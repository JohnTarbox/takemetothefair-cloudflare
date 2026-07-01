-- OPE-37 (promoter-enrichment notice, 2026-07-01) — cron debounce state.
--
-- Promoter analog of roster_research_notice_state (OPE-15, drizzle/0134) and
-- inbound_exception_notice_state (OPE-17, drizzle/0136). One-row table that
-- debounces the daily notice fired when the promoter NEEDS_ENRICHMENT queue is
-- non-empty: ≤1/day AND only when the queue depth CHANGED since the last fire.
--
--   id                → constant PK ("promoter_enrichment_notice"); single row.
--   last_notice_date  → UTC YYYY-MM-DD of the last fire (the ≤1/day gate).
--   last_queue_count  → NEEDS_ENRICHMENT count at last fire (change-detector).
--   last_notified_at  → unix-seconds timestamp of the last fire (audit).
--
-- No writes to existing tables; safe to apply ahead of the code that reads it
-- (an absent row reads as "never notified" ⇒ first non-empty queue notifies).
CREATE TABLE `promoter_enrichment_notice_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_notice_date` text NOT NULL,
	`last_queue_count` integer NOT NULL,
	`last_notified_at` integer NOT NULL
);
