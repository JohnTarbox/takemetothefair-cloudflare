-- 0059: §6.3 KPI state-machine history.
--
-- One row per (kpi_name, computed_at). The */10 cron in mcp-server writes 5
-- rows per fire — one per KPI in src/lib/kpi-thresholds.ts. The Overview tab
-- reads the latest row per KPI to drive GREEN/YELLOW/RED card coloring; the
-- action queue derives P0/P1 entries from the same source.
--
-- Volume: 5 KPIs × 6/hr × 24 × 90d = ~65k rows. Pruned to 90d by the
-- recompute job.
--
-- Powers /admin/analytics Overview state machine + action queue.

CREATE TABLE kpi_state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kpi_name TEXT NOT NULL,
  computed_at INTEGER NOT NULL,                 -- unix seconds (Drizzle mode:"timestamp")
  value REAL,                                   -- nullable when state='INDETERMINATE'
  state TEXT NOT NULL,                          -- GREEN | YELLOW | RED | INDETERMINATE
  state_changed_from_previous INTEGER NOT NULL DEFAULT 0,
  first_detected_at INTEGER,                    -- when CURRENT state run started; carries forward
  meta TEXT                                     -- JSON: numerator/denominator/window for trace
);

CREATE INDEX idx_kpi_state_history_name_at ON kpi_state_history(kpi_name, computed_at);
