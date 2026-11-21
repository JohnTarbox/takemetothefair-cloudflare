-- OPE-1506 — heartbeat probe for enrich-on-match AUTO-APPLY (trusted senders and
-- verified organizers write empty, allowed fields; `dedup.enrich_applied`).
-- DEMAND-CONDITIONAL: a staged enrich row whose payload names a qualifying
-- sender (`autoApply.basis`) and an eligible field owes an applied row.
-- DORMANT (enabled_at NULL): the writer ships in the MCP Worker, deployed
-- separately from the app that reads the probe. Arm once that deploy is live:
--   UPDATE heartbeat_probes SET enabled_at = unixepoch(), updated_at = unixepoch()
--   WHERE probe_name = 'enrich-auto-apply';
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'enrich-auto-apply',
  NULL,
  'OPE-1506 — enrich-on-match auto-apply writes dedup.enrich_applied; dormant until the MCP deploy carrying the writer is live',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
