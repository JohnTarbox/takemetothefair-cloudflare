-- email_source_suggestions — registry of source domains suggested via
-- inbound email. Backs the 3-tier source_suggestion handler (spec §C.8).
--
-- **Why the filename says `discovery_candidates` but the table is named
-- `email_source_suggestions`**: this migration originally created a table
-- called `discovery_candidates` in PR-D. After merging PR-D but before
-- applying the migration to prod, the discovery_candidates name collision
-- with a pre-existing prod table (rule_slug / source_type schema, 24
-- rows, used by an unrelated harvest-rules feature) was caught. The
-- migration file was rewritten in PR-F to create the renamed table; the
-- filename stays as 0084 because preserving migration-numbering continuity
-- matters more than the filename matching the new table name. Future
-- editors: search for `emailSourceSuggestions` in code (Drizzle table
-- binding) — the SQL table name is `email_source_suggestions`.
--
-- Three-tier lookup flow (mcp-server/src/email-handlers/source-suggestion.ts):
--   Tier 1: SELECT FROM email_source_suggestions WHERE host=? AND status='active'
--           → "we already pull from this source" reply.
--   Tier 2: events.source_url LIKE '%host%' check (informal usage)
--           → "we already use this source, admin will formally register"
--   Tier 3: INSERT a new row with status='pending_review'
--           → "thanks, queued for review" reply.
--
-- status lifecycle:
--   pending_review (default) — submitter just emailed; admin hasn't seen yet
--   active                   — admin approved; treat as an active source
--   rejected                 — admin reviewed and declined

CREATE TABLE email_source_suggestions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  suggested_by_email TEXT,
  suggested_via_inbound_id TEXT,
  reviewed_at INTEGER,
  reviewed_by_user_id TEXT,
  admin_notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_email_source_suggestions_host ON email_source_suggestions (host);
CREATE INDEX idx_email_source_suggestions_status ON email_source_suggestions (status);
CREATE UNIQUE INDEX uq_email_source_suggestions_pending_host
  ON email_source_suggestions (host)
  WHERE status = 'pending_review';
