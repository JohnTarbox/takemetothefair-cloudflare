-- OPE-1664 — error_logs rows whose D1 insert failed now go to a KV buffer
-- (src/lib/observability/error-log-buffer.ts) and the MCP */10 cron replays
-- them via /api/internal/error-log-buffer/replay. OPE-246: the new cron path
-- ships with its probe. Evidence is the `watchdog:error-log-buffer-replay`
-- agent_heartbeats stamp, written on every completed drain (empty included).
-- Live from the ship date: no flag gates the replay.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'error-log-buffer-replay',
  unixepoch(),
  'OPE-1664 — the */10 cron drained the KV buffer of error_logs rows a D1 overload kept out of the table',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
