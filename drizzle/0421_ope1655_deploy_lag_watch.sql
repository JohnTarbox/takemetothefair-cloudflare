-- OPE-1655 — heartbeat probe for the hourly deploy-lag watch (MCP cron).
-- Touches heartbeat_probes only (no FK), so it is a no-op-safe insert on an
-- empty database. Live from the ship date: the watch stamps
-- `watchdog:deploy-lag` on every hourly run, whatever its verdict, so there is
-- nothing for this probe to wait on.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'deploy-lag-watch',
  1794787200,
  'OPE-1655 — watchdog:deploy-lag stamped within 3h (hourly prod-behind-main alarm)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
