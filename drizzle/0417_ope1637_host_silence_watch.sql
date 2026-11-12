-- OPE-1637 — heartbeat probe for the hourly host-silence watch (MCP cron).
-- Touches heartbeat_probes only (no FK), so it is a no-op-safe insert on an
-- empty database. Live from the ship date: the watch stamps on every hourly run,
-- dormant or not, so there is nothing for this probe to wait on.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'host-silence-watch',
  1794355200,
  'OPE-1637 — watchdog:host-silence stamped within 3h (hourly 75-min Battleship host alarm)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
