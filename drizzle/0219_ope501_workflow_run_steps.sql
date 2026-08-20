-- OPE-501 — per-step evidence for a Workflow run.
--
-- `workflow_instance_id` was surfaced on every admin record and carried in every
-- trace, and nothing accepted it. It identified nothing an agent could open.
--
-- The Workflows binding IS reachable from the MCP Worker, but
-- `WorkflowInstance.status()` returns only { status, error?, output? } — the
-- instance's state, never its steps. Per-step history lives in the Cloudflare
-- dashboard/REST API, behind credentials this Worker does not carry. So the only
-- way to answer "did ocr-attachments actually fire?" is to write it down as it
-- happens.
--
-- `skipped` is why this is not just error logging: a step that never ran is
-- indistinguishable from one that ran and found nothing, unless the skip is
-- recorded as deliberately as the run.
--
-- ⚠️ NOT backfillable — runs before this ships stay opaque.
CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL,
  workflow_name    TEXT NOT NULL,
  inbound_email_id TEXT,
  step_name        TEXT NOT NULL,
  status           TEXT NOT NULL,
  detail           TEXT,
  duration_ms      INTEGER,
  recorded_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_instance ON workflow_run_steps (instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_email    ON workflow_run_steps (inbound_email_id);
