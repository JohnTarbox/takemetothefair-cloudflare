-- OPE-1345 — the weekly promoter-outreach lane records each run, so its
-- heartbeat measures "the lane ran" rather than "an email went out". The lane
-- is research-first (John, 2026-10-13: ruling A, amended): most weeks fix
-- listings from the organizer's own page and send nothing, which the old
-- evidence source (promoter_outreach_attempts) reads as silence.
--
-- Additive table + a note on the existing probe row. No-op on an empty DB:
-- the UPDATE matches nothing when the seed row is absent.
CREATE TABLE promoter_outreach_runs (
  id TEXT PRIMARY KEY,
  ran_at INTEGER NOT NULL,
  events_reviewed INTEGER NOT NULL DEFAULT 0,
  resolved_from_web INTEGER NOT NULL DEFAULT 0,
  drafts_for_approval INTEGER NOT NULL DEFAULT 0,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  recorded_by TEXT,
  note TEXT
);

CREATE INDEX idx_promoter_outreach_runs_ran_at ON promoter_outreach_runs(ran_at);

UPDATE heartbeat_probes
SET updated_at = unixepoch(),
    note = 'OPE-1345: evidence = newer of promoter_outreach_runs.ran_at and promoter_outreach_attempts.created_at; window 216h (weekly Tuesday lane + 2d slack), see heartbeat.ts'
WHERE probe_name = 'promoter-outreach-attempts';
