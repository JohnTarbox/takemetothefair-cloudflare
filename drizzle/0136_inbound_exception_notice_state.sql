-- OPE-17 (2026-06-29) — debounce state for the inbound-email human-triage
-- exception-queue notice. Exact analog of roster_research_notice_state
-- (drizzle/0134, OPE-15).
--
-- After the daily 06:00 UTC sweep reconciles inbound-email exception statuses
-- (auto-correct already-handled rows → 'salvaged'; auto-dispose spam/unsubscribe
-- → reversible 'rejected'), a notice fires when the count of TRUE salvage
-- candidates is non-empty AND changed since the last notice — telling the
-- operator there is interactive triage to do (the OPE-16 analyst task).
--
--   id                → constant PK ("inbound_exception_notice"); single row.
--   last_notice_date  → UTC YYYY-MM-DD of the last fire (the ≤1/day gate).
--   last_queue_count  → salvage-candidate count at last fire (change-detector).
--   last_notified_at  → unix-seconds timestamp of the last fire (audit).
--
-- No writes to existing tables; safe to apply ahead of the code that reads it
-- (an absent row reads as "never notified" ⇒ first non-empty queue notifies).
CREATE TABLE IF NOT EXISTS inbound_exception_notice_state (
  id                TEXT PRIMARY KEY,
  last_notice_date  TEXT NOT NULL,
  last_queue_count  INTEGER NOT NULL,
  last_notified_at  INTEGER NOT NULL
);
