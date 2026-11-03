-- OPE-1239 — the CI-trigger watchdog moves to the MCP Worker's */10 cron.
--
-- 1. Grace: how many minutes main's HEAD may go without a push-triggered CI run
--    before the watchdog emails. 15 = the GitHub-workflow version's value
--    (OPE-1227); a push CI run normally registers within seconds.
-- 2. Heartbeat probe: admin_actions `ci.trigger_watchdog.run` (stamped at most
--    hourly) must appear within 3h. Enabled on the ship date (OPE-246).
-- Plain inserts, no FK — a no-op-safe seed on an empty (CI) database.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'ci_trigger_watchdog_grace_minutes',
  15,
  'minutes',
  'OPE-1239 — main HEAD older than this with no push-triggered CI run emails ALERT_EMAIL_TECHNICAL (once per SHA).',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'ci-trigger-watchdog',
  unixepoch(),
  'OPE-1239 - admin_actions action=ci.trigger_watchdog.run must appear at least every 3h (*/10 cron, stamped at most hourly).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
