-- OPE-993 — heartbeat probes for the scheduled error_logs and
-- indexnow_submissions retention runs (mcp-server/src/log-table-retention.ts,
-- MCP 06:00Z cron). Armed on ship: the cron runs from the deploy that carries
-- this migration. Each probe watches its run stamp (agent_heartbeats
-- 'watchdog:error-log-retention' / 'watchdog:indexnow-submission-retention'),
-- written on every SUCCESSFUL run whether or not anything aged out, and NOT
-- written when the prune throws — so a broken delete reads as silence.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'error-log-retention',
  unixepoch(),
  'OPE-993 — error_logs 30-day retention, daily MCP cron run stamp (was a 1% dice roll on the logger write path)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'indexnow-submission-retention',
  unixepoch(),
  'OPE-993 — indexnow_submissions 30-day retention, daily MCP cron run stamp (was a 1% dice roll on the IndexNow submission write path)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
