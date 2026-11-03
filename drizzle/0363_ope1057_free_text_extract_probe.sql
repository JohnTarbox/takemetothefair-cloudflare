-- OPE-1057 rework — heartbeat probe for the inbound Workflow's B2 free-text
-- branch, which now writes one `workflow_run_steps` row ('submit/free-text-extract',
-- status ok / failed / skipped) per run. Before this, a failed extraction wrote
-- nothing (inbound 01ad5525, 2026-10-14). DEMAND-CONDITIONAL: only free_text,
-- URL-less, attachment-less submissions received after `enabled_at` count.
-- DORMANT (enabled_at NULL): the writer ships in the MCP Worker, deployed
-- separately from the app that reads the probe. Arm once that deploy is live:
--   UPDATE heartbeat_probes SET enabled_at = unixepoch(), updated_at = unixepoch()
--   WHERE probe_name = 'free-text-extract-record';
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'free-text-extract-record',
  NULL,
  'OPE-1057 — B2 free-text extraction run record; dormant until the MCP deploy carrying the writer is live',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
