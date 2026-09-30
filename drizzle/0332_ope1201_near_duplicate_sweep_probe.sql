-- OPE-1201 — seed the near-duplicate-sweep heartbeat probe, ARMED.
--
-- CLAUDE.md (OPE-246): a new cron / writer path ships WITH its probe. The MCP
-- Worker's daily cron POSTs /api/admin/duplicates/near-sweep, which writes one
-- admin_actions row (action = 'event.near_duplicate_sweep') per run. Window 48h,
-- so the first daily run after this deploy lands well inside it.
--
-- No-op on an empty database: no foreign keys, ON CONFLICT DO NOTHING.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'near-duplicate-sweep',
  unixepoch(),
  'OPE-1201 - admin_actions action=event.near_duplicate_sweep must appear at least every 48h (daily cron, one row per run, even when nothing is flagged).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
