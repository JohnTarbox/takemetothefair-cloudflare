-- Inbound email persistence — every message received by the MCP Worker's
-- email() entrypoint gets a row here, regardless of intent. Drives the
-- InboundEmailWorkflow's per-step state machine (`status` column) and
-- gives the admin a queryable inbox without parsing Cloudflare Email
-- Routing's Activity log.
--
-- Created by PR for the multi-intent email refactor; see
-- docs/inbound-email.md for the routing semantics and intent vocabulary.

CREATE TABLE inbound_emails (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  workflow_instance_id TEXT,
  body_text_excerpt TEXT,
  -- URL extracted from the email body by pickPrimaryUrl during the
  -- email() entrypoint. Stored as a column rather than rebuilt inside
  -- the workflow step because we only retain 500 chars of body in
  -- body_text_excerpt — the URL might be deeper than that.
  parsed_url TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  raw_size INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX idx_inbound_emails_received_at ON inbound_emails(received_at DESC);
CREATE INDEX idx_inbound_emails_intent ON inbound_emails(intent);
CREATE INDEX idx_inbound_emails_status ON inbound_emails(status);
CREATE INDEX idx_inbound_emails_from ON inbound_emails(from_address);
