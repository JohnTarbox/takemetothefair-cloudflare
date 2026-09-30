-- OPE-1121 Phase 2 (4/13): problem_reports gains its foreign key.
--
-- inbound_email_id → inbound_emails(id) ON DELETE SET NULL. A report is its own record.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references problem_reports; checked against prod sqlite_master 2026-09-23, along with
-- 0 triggers and 0 views on it). Never a parent: D1 always enforces FKs, and
-- DROP TABLE on a parent runs an implicit DELETE that fires ON DELETE actions.
-- Orphans on the new FK column in prod, re-measured 2026-09-23: 0.
--
-- Failure safety does NOT rely on the file being atomic. wrangler sends this
-- file and its d1_migrations INSERT as ONE /query request (wrangler 4.131
-- buildMigrationQuery + executeRemotely); D1 documents batch() as a
-- transaction but says nothing either way for a multi-statement /query. So
-- every check that can fail — an orphan the INSERT rejects, the count check —
-- runs BEFORE the DROP of the original table. A failure there leaves the
-- original untouched, and the two DROP IF EXISTS lines below clear any
-- leftover scratch table, so a re-run starts clean.
--
-- NO `PRAGMA defer_foreign_keys`. The rehearsal (OPE-1121 PR) planted one
-- orphan and, WITH deferral, this rebuild copied it, declared the FK anyway,
-- and recorded the migration: the deferred check never fired. Deferral is not
-- needed here — no parent is touched — so the FK is checked row by row on the
-- INSERT, and the assertion below counts orphans explicitly as well, so a
-- failure does not depend on pragma semantics at all.

DROP TABLE IF EXISTS problem_reports__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE problem_reports__ope1121 (
  id TEXT PRIMARY KEY,
  reporter_email TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT,
  user_agent TEXT,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  severity TEXT NOT NULL DEFAULT 'LOW',
  correlated_error_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by_user_id TEXT,
  notes TEXT,
  kind TEXT NOT NULL DEFAULT 'defect'
);

INSERT INTO problem_reports__ope1121 (id, reporter_email, body, source, path, user_agent, inbound_email_id, severity, correlated_error_count, created_at, resolved_at, resolved_by_user_id, notes, kind)
SELECT id, reporter_email, body, source, path, user_agent, inbound_email_id, severity, correlated_error_count, created_at, resolved_at, resolved_by_user_id, notes, kind FROM problem_reports;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM problem_reports__ope1121) = (SELECT count(*) FROM problem_reports)
   AND (SELECT count(*) FROM problem_reports__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE problem_reports;
ALTER TABLE problem_reports__ope1121 RENAME TO problem_reports;

CREATE INDEX idx_problem_reports_kind_resolved ON problem_reports (kind, resolved_at);
CREATE INDEX idx_problem_reports_severity_resolved_created ON problem_reports (severity, resolved_at, created_at DESC);
CREATE INDEX idx_problem_reports_source ON problem_reports (source);
CREATE INDEX idx_problem_reports_unresolved ON problem_reports (created_at DESC) WHERE resolved_at IS NULL;
