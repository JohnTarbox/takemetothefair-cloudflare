-- OPE-456 — heartbeat probe for the daily derived-milestone generator
-- (MCP daily cron → gsc-metrics sync → POST /api/admin/analytics/gsc-milestones/derive).
-- ARMED at ship: the route logs an info row on every successful run, crossing or
-- not, so a healthy daily run always leaves evidence. 48h window.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'gsc-milestone-derivation',
  unixepoch(),
  'OPE-456 — daily derived click-milestone run; evidence = newest info error_logs row from the derive route',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
