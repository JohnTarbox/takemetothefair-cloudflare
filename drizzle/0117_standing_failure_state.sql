-- A5 (2026-06-08) — standing-failure detector debounce state.
--
-- Companion to the page-error canary (drizzle/0103 + 0105). That canary
-- watches for ERROR RATE bursts in a 10-minute window — good for catching
-- deploy regressions and live outages. It missed REL3's signal because
-- REL3 produced ONE error per day for 22 days, never crossing the
-- per-window threshold.
--
-- This detector watches for the orthogonal signal: ERROR PERSISTENCE
-- across days. For each distinct error_logs.source over a 7-day window,
-- count distinct calendar days with errors. If ≥3 days AND today is one
-- of them, fire a STANDING-tier alert.
--
-- Debounce 7 days per source — once we've alerted, the operator either
-- fixes it (alert goes away) or is already aware (don't spam).
--
-- Single PK on source (not (tier, source) like page_error_canary_state)
-- because there's only one tier — STANDING.

CREATE TABLE IF NOT EXISTS standing_failure_state (
  source             TEXT PRIMARY KEY,         -- e.g. 'mcp:workflow:recommendations-scan'
  last_alerted_at    INTEGER NOT NULL,         -- seconds-epoch
  last_day_count     INTEGER NOT NULL,         -- distinct days at last dispatch
  last_total_count   INTEGER NOT NULL          -- total errors in window at dispatch
);
