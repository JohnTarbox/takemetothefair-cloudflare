-- OPE-237 — heartbeat probe for the nightly vendor-claim corroboration pass
-- (MCP 08:30Z cron → /api/admin/claims/corroborate). Armed on ship: the cron
-- runs from the deploy that carries this migration. Evidence is the run row
-- admin_actions action='claim.corroborate.sweep', written on every completed
-- sweep call whether or not anything was eligible.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'claim-corroboration-sweep',
  unixepoch(),
  'OPE-237 — nightly declared-website corroboration pass run row (was admin-triggered only, never triggered)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
