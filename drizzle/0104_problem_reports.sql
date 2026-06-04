-- UR1 Phase 1 (2026-06-04) — user-reported problem tracking.
--
-- Direct response to the 2026-06-03/04 D1 100-col outage being caught by a
-- user, not by monitoring (MTTD ≈17h). The web form + email intake both
-- write rows here; the intake hook runs the same `error_logs` burst-watch
-- (mcp-server/src/error-logs-burst.ts) the page-error canary uses, and
-- escalates severity HIGH when a report co-occurs with an active error
-- burst — turning a user report into a real-time outage signal.
--
-- Why a fresh table vs piggy-backing inbound_emails:
--   - Web-form reports have no email-protocol context (no Message-ID,
--     no thread). Email-source reports DO reference inbound_emails via
--     `inbound_email_id`.
--   - The reply lifecycle is operator → reporter (manual), not the
--     auto-extract pipeline that inbound_emails feeds.
--   - Triage workflow needs its own resolved/notes fields distinct
--     from inbound_emails.status.

CREATE TABLE IF NOT EXISTS problem_reports (
  id                       TEXT    PRIMARY KEY,            -- uuid
  reporter_email           TEXT,                            -- null for anonymous web submissions
  body                     TEXT    NOT NULL,                -- the user's description
  source                   TEXT    NOT NULL,                -- 'web' | 'email'
  path                     TEXT,                            -- page the user was on, when known
  user_agent               TEXT,                            -- captured at web intake; null for email
  inbound_email_id         TEXT,                            -- FK to inbound_emails(id); null for web
  severity                 TEXT    NOT NULL DEFAULT 'LOW',  -- 'LOW' | 'HIGH'
  correlated_error_count   INTEGER NOT NULL DEFAULT 0,      -- error_logs count in -30m/+5m window
  created_at               INTEGER NOT NULL,                -- unix seconds
  resolved_at              INTEGER,                         -- unix seconds when operator marks done
  resolved_by_user_id      TEXT,                            -- FK to users(id), set on resolve
  notes                    TEXT                             -- operator notes
);

-- Indexes — common admin queries:
--   /admin/problem-reports filters by severity + resolved-state + sort by date.
--   MCP list_problem_reports same.
--   Correlation backfill (correlate_problem_report) keys by id (PK, already indexed).
CREATE INDEX IF NOT EXISTS idx_problem_reports_severity_resolved_created
  ON problem_reports (severity, resolved_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_problem_reports_source
  ON problem_reports (source);

-- Partial index on unresolved rows — the admin's default view is "open"
-- (resolved_at IS NULL); this avoids scanning the resolved history.
CREATE INDEX IF NOT EXISTS idx_problem_reports_unresolved
  ON problem_reports (created_at DESC) WHERE resolved_at IS NULL;
