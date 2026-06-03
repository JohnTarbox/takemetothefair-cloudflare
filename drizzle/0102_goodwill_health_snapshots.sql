-- GW1e (analyst, 2026-06-02). Goodwill Engine CPI report-card +
-- Slack-canary substrate. Mirrors the dedup_sweep_snapshots table
-- shape from drizzle/0099 — daily snapshot, UNIQUE on snapshot_date,
-- 72h debounce state for YELLOW alerts.
--
-- The canary in mcp-server/src/goodwill/health-canary.ts polls the
-- open queue + weighted priority sum once per day on the existing
-- 0 6 * * * cron, writes a row here, and dispatches a Slack alert
-- when the queue grows materially:
--
--   RED   on +1 open-queue growth day-over-day. Always fires (no
--         debounce). Same shape as RED transitions in the KPI alerts
--         system (PR #277) and the dedup-sweep canary (PR #306).
--   YELLOW on >10% growth over the prior 7-day rolling avg of the
--         weighted-priority sum. Debounced 72h.
--
-- Routes to SLACK_WEBHOOK_URL_TECHNICAL (shared with the existing
-- KPI + dedup canaries). When the secret isn't set the helper no-ops
-- cleanly.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('goodwill_health_snapshots');
-- Expected: not found. Use Cloudflare MCP d1_database_query to verify
-- against prod D1 before applying.

CREATE TABLE IF NOT EXISTS goodwill_health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  -- Queue health
  open_count INTEGER NOT NULL,
  outreach_candidate_count INTEGER NOT NULL,
  weighted_priority_sum REAL NOT NULL,
  -- Per-detector breakdown (for the report-card pie)
  open_ingest_addverify INTEGER NOT NULL DEFAULT 0,
  open_stale_page_radar INTEGER NOT NULL DEFAULT 0,
  open_self_consistency INTEGER NOT NULL DEFAULT 0,
  open_manual INTEGER NOT NULL DEFAULT 0,
  -- Resolution health (28-day rolling)
  resolved_last_28d INTEGER NOT NULL DEFAULT 0,
  dismissed_last_28d INTEGER NOT NULL DEFAULT 0,
  -- Per-source-tier reliability spread (median scores by axis)
  median_official_freshness REAL,
  median_official_accuracy REAL,
  median_aggregator_accuracy REAL,
  -- 72h debounce state for YELLOW alerts. NULL = never alerted.
  last_yellow_alerted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodwill_snapshot_date
  ON goodwill_health_snapshots(snapshot_date);
