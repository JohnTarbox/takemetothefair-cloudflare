-- 0056: §10.2 enrichment audit trail.
--
-- Append-only log of every enrichment attempt across all sources. Unbounded
-- for now per business decision; cap when row count justifies the chore.
--
-- Sources (text, not enum at DB level — enum lives in TS):
--   ai_workers     — Cloudflare Workers AI URL-import path
--   scraper        — mainefairs.net etc. parser
--   manual_admin   — admin edited via UI/MCP update tool
--   vendor_self    — vendor edited via /vendor/* portal or claim flow
--   mcp_create     — MCP create_vendor / create_event
--
-- Status (text):
--   success | failure | skipped

CREATE TABLE enrichment_log (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,             -- 'vendor' | 'event'
  target_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  fields_changed TEXT,                   -- JSON array of field names
  notes TEXT,
  actor_user_id TEXT
);

CREATE INDEX idx_enrichment_log_target ON enrichment_log(target_type, target_id);
CREATE INDEX idx_enrichment_log_attempted_at ON enrichment_log(attempted_at);
CREATE INDEX idx_enrichment_log_source_status ON enrichment_log(source, status);
