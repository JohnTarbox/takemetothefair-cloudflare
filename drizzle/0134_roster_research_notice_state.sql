-- OPE-15 (vendor-roster research notice, 2026-06-29) — cron debounce state.
--
-- Companion to OPE-13's rails. After the daily 06:00 UTC occurred-sweep seeds
-- the producer-class NEEDS_RESEARCH queue (Pass 3 of event-occurred-sweep.ts),
-- a notice fires telling the operator there is interactive roster research to
-- do (the OPE-14 analyst sweep needs web_fetch and can't run unattended).
--
-- This one-row table debounces that notice: it fires at most once per day AND
-- only when the producer-class NEEDS_RESEARCH count CHANGED since the last
-- notice, so an unchanged backlog goes quiet instead of nagging daily.
--
--   id                → constant PK ("roster_research_notice"); single row.
--   last_notice_date  → UTC YYYY-MM-DD of the last fire (the ≤1/day gate).
--   last_queue_count  → producer-class NEEDS_RESEARCH count at last fire
--                       (the change-detector: equal count ⇒ skip).
--   last_notified_at  → unix-seconds timestamp of the last fire (audit).
--
-- Mirrors the standing_failure_state debounce pattern (drizzle/0117). No
-- writes to existing tables; safe to apply ahead of the code that reads it
-- (an absent row reads as "never notified" ⇒ first non-empty queue notifies).
CREATE TABLE IF NOT EXISTS roster_research_notice_state (
  id                TEXT PRIMARY KEY,
  last_notice_date  TEXT NOT NULL,
  last_queue_count  INTEGER NOT NULL,
  last_notified_at  INTEGER NOT NULL
);
