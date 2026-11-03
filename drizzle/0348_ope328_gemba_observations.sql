-- OPE-328 (Demux D-3) — gemba@ observations, queued in D1 for agents to post.
--
-- John's ruling (2026-09-30): queue gemba emails in D1 for an agent session to
-- post to the project's Linear anchor; no Linear token on the Worker. One row
-- per gemba@ email, tagged with a project. `pending` rows have an anchor issue
-- to post to; `held` rows could not be tagged unambiguously (or the project has
-- no anchor yet) and wait for a person — never guessed, never dropped.
CREATE TABLE IF NOT EXISTS gemba_observations (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES inbound_emails(id) ON DELETE CASCADE,
  project TEXT,
  anchor_issue TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'posted')),
  routing_reason TEXT NOT NULL,
  posted_ref TEXT,
  posted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gemba_observations_status ON gemba_observations (status, created_at);

-- Heartbeat (OPE-246): DORMANT until the gemba@ Email Routing rule exists in
-- the Cloudflare dashboard. Set enabled_at the day the first real row lands.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('gemba-observation', NULL, 'OPE-328: dormant until the gemba@ Email Routing rule is created', unixepoch());
