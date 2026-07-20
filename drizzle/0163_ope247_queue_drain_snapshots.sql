-- OPE-247 — per-queue drain-ratio daily snapshots.
--
-- One row per work-queue per UTC day, written by the daily stale-red scan
-- (/api/internal/cpi/stale-red-scan) alongside the OPE-75 alert, so the
-- /admin/analytics tile, the persisted trend, and the frozen-queue RED all read
-- the same numbers on the same beat.
--
-- The (queue_name, snapshot_date) unique index makes the daily write an
-- idempotent UPSERT (safe to re-run the scan same-day) and lets the inbound
-- exception queue — whose outflow is NOT timestamp-derivable — recover its
-- outflow as a day-over-day depth delta from the prior row.
CREATE TABLE queue_drain_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,       -- YYYY-MM-DD (UTC)
  depth INTEGER NOT NULL,            -- current open/pending backlog
  inflow_1d INTEGER NOT NULL,        -- rows entering in trailing 24h
  outflow_1d INTEGER,               -- rows decided/closed in 24h; NULL when not yet computable
  drain_ratio_7d REAL,              -- trailing-7d outflow / inflow; NULL when inflow 0 or outflow unknown
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_queue_drain_date ON queue_drain_snapshots (queue_name, snapshot_date);
