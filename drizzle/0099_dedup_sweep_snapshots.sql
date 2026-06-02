-- A3 / K2 part 7 (analyst 2026-06-01 EVE): daily dedup-sweep snapshot
-- table. Backs the Slack-canary cron in mcp-server/src/dedup-sweep-
-- canary.ts which polls /api/admin/duplicates/sweep once per day,
-- writes a row here, and dispatches a Slack alert when the cluster
-- count moves materially.
--
-- Alert tiers (per the bundle's chosen design):
--   - RED on +1 cluster growth day-over-day. Always fires (no debounce).
--     Any new cluster is a regression worth surfacing immediately, the
--     same shape as RED transitions in the KPI alerts system (PR #277).
--   - YELLOW on >10% growth over the prior 7-day rolling avg of total
--     cluster count. Debounced 72h per the KPI YELLOW pattern (so a
--     noisy oscillating canary doesn't spam the channel). Debounce
--     state is tracked inline via last_yellow_alerted_at.
--
-- Routes to SLACK_WEBHOOK_URL_TECHNICAL — same channel as the
-- technical KPI alerts. The webhook is a secret bound on the MCP
-- Worker; if not set the helper no-ops cleanly (no error).
--
-- One row per (snapshot_date) — UNIQUE constraint enforces. The
-- canary uses ON CONFLICT DO UPDATE so re-running the cron same-day
-- (e.g. manual trigger after a Slack channel test) updates the row
-- in place rather than failing.

CREATE TABLE IF NOT EXISTS dedup_sweep_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  total_clusters INTEGER NOT NULL,
  venue_date_clusters INTEGER NOT NULL,
  city_state_date_clusters INTEGER NOT NULL,
  events_in_clusters INTEGER NOT NULL,
  -- Seconds-epoch of the most-recent YELLOW Slack dispatch for this
  -- canary. NULL = never YELLOW-alerted. Used by the 72h debounce
  -- check: if (now - last_yellow_alerted_at) < 72h, suppress the
  -- next YELLOW. RED bypasses entirely.
  last_yellow_alerted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup_snapshot_date
  ON dedup_sweep_snapshots(snapshot_date);
