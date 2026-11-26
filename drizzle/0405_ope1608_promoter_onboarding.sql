-- OPE-1608: the promoter onboarding lane. One row per organizer asking to get
-- their events listed. It records the match report and the staged promoter
-- (a promoter row would be public the moment it exists), and drives the
-- enrich -> draft -> alert -> follow-up sequence. Sends nothing to the sender.
CREATE TABLE promoter_onboarding_requests (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES inbound_emails(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL,
  org_domain TEXT,
  org_name TEXT,
  match_report TEXT,
  staged_promoter TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'queued',
  enrichment_detail TEXT,
  enrichment_finished_at INTEGER,
  obligation_id TEXT,
  target_at INTEGER,
  draft_id TEXT,
  draft_composed_at INTEGER,
  draft_missing_fault_at INTEGER,
  notified_at INTEGER,
  reminded_at INTEGER,
  deadline_fault_at INTEGER,
  replied_at INTEGER,
  claimed_at INTEGER,
  first_submission_at INTEGER,
  followup_draft_id TEXT,
  followup_composed_at INTEGER,
  followup_target_at INTEGER,
  followup_notified_at INTEGER,
  followup_reminded_at INTEGER,
  followup_deadline_fault_at INTEGER,
  followup_sent_at INTEGER,
  closed_at INTEGER,
  close_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_promoter_onboarding_open ON promoter_onboarding_requests(closed_at, created_at);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-onboarding',
  unixepoch(),
  'OPE-1608 — the lane pass ran, and no request is overdue for a draft or a send',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
