-- OPE-971 — heartbeat probe for the scheduled request_samples retention run
-- (mcp-server/src/request-sample-retention.ts, MCP 06:00Z cron). Armed on ship:
-- the cron runs from the deploy that carries this migration, and the probe
-- watches its run stamp (agent_heartbeats 'watchdog:request-sample-retention'),
-- which is written every run whether or not anything aged out.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'request-sample-retention',
  unixepoch(),
  'OPE-971 — request_samples 60-day retention, daily MCP cron run stamp (was a 1% dice roll on the middleware write path)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
