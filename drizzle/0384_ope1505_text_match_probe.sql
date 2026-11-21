-- OPE-1505 — heartbeat probe for the no-URL submit branch's deterministic text
-- match, which writes one `workflow_run_steps` row ('submit/text-match') per run,
-- matched or not. DEMAND-CONDITIONAL: free_text, URL-less, attachment-less
-- submissions received after `enabled_at` count.
-- DORMANT (enabled_at NULL): the writer ships in the MCP Worker, deployed
-- separately from the app that reads the probe. Arm once that deploy is live:
--   UPDATE heartbeat_probes SET enabled_at = unixepoch(), updated_at = unixepoch()
--   WHERE probe_name = 'text-match-record';
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'text-match-record',
  NULL,
  'OPE-1505 — no-URL submission text-match run record; dormant until the MCP deploy carrying the writer is live',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
