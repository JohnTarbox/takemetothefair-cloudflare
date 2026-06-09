-- REL3 (2026-06-08) — cursor-resume state for the recommendations-scan
-- workflow. The previous design ran ALL 23 recommendation rules in one
-- daily Workflow instance, looping `chunk=4` rules at a time inside a
-- single `step.do`. A single rule that exceeded the 5-minute per-step
-- timeout aborted the whole sweep — silently logged as "transient" 24×
-- over 22 distinct days (earliest 2026-05-18, latest 2026-06-08 06:16Z).
--
-- New design persists a cursor across cron invocations so each fire
-- processes N chunks (N=3 default → 12 rules/day → ~2-day cycle) and
-- exits cleanly inside its budget. When the cursor reaches the end of
-- ALL_RULES, it wraps to 0 and bumps `completed_cycles`.
--
-- Single-row table, id='default'. Admin UI surfaces cycle progress
-- from this row. See mcp-server/src/workflows/recommendations-scan.ts
-- for the read-cursor → process → persist-cursor step shape.

CREATE TABLE IF NOT EXISTS recommendation_scan_state (
  id                 TEXT PRIMARY KEY,         -- always 'default'
  cursor             INTEGER NOT NULL DEFAULT 0,
  cycle_started_at   INTEGER,                  -- seconds-epoch
  last_run_at        INTEGER,                  -- seconds-epoch
  last_run_chunks    INTEGER NOT NULL DEFAULT 0,
  completed_cycles   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER                   -- seconds-epoch
);

-- Seed the single row so the workflow's read-cursor step never has to
-- handle a missing-row case. cursor=0 means "start at top of ALL_RULES".
INSERT OR IGNORE INTO recommendation_scan_state (id, cursor, last_run_chunks, completed_cycles)
VALUES ('default', 0, 0, 0);
