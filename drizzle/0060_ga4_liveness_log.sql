-- 0060: §6.3 Phase 2 GA4 liveness check log.
--
-- One row per daily liveness check. Tracks consecutive failures so the
-- alert fires only after 2 consecutive critical/degraded fires (avoids
-- flapping on transient GA4 API blips).
--
-- Wired in mcp-server/src/index.ts:runScheduledGa4LivenessCheck (daily
-- 06:00 UTC cron) → POST /api/admin/ga4-liveness with X-Internal-Key.
-- On 2 consecutive failures, writes admin_actions ga4.liveness_alert
-- which surfaces as a P0 entry in the action queue.

CREATE TABLE ga4_liveness_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at INTEGER NOT NULL,                       -- unix seconds
  status TEXT NOT NULL,                              -- 'green' | 'degraded' | 'critical'
  max_data_date TEXT,                                -- YYYY-MM-DD or NULL
  data_age_seconds INTEGER,                          -- age of max_data_date at check time
  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- carries forward across checks
  alert_fired INTEGER NOT NULL DEFAULT 0             -- 1 when this row triggered the audit alert
);

CREATE INDEX idx_ga4_liveness_log_checked_at ON ga4_liveness_log(checked_at);
