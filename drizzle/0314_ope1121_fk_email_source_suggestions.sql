-- OPE-1121 Phase 2 (7/13): email_source_suggestions gains its foreign key.
--
-- suggested_via_inbound_id → inbound_emails(id) ON DELETE SET NULL. idx_..._inbound is NEW, for the same reason as 0313.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references email_source_suggestions; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS email_source_suggestions__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE email_source_suggestions__ope1121 (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  suggested_by_email TEXT,
  suggested_via_inbound_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  reviewed_by_user_id TEXT,
  admin_notes TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO email_source_suggestions__ope1121 (id, url, host, status, suggested_by_email, suggested_via_inbound_id, reviewed_at, reviewed_by_user_id, admin_notes, created_at)
SELECT id, url, host, status, suggested_by_email, suggested_via_inbound_id, reviewed_at, reviewed_by_user_id, admin_notes, created_at FROM email_source_suggestions;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM email_source_suggestions__ope1121) = (SELECT count(*) FROM email_source_suggestions)
   AND (SELECT count(*) FROM email_source_suggestions__ope1121 c WHERE c.suggested_via_inbound_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.suggested_via_inbound_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE email_source_suggestions;
ALTER TABLE email_source_suggestions__ope1121 RENAME TO email_source_suggestions;

CREATE INDEX idx_email_source_suggestions_host ON email_source_suggestions (host);
CREATE INDEX idx_email_source_suggestions_status ON email_source_suggestions (status);
CREATE UNIQUE INDEX uq_email_source_suggestions_pending_host ON email_source_suggestions (host) WHERE status = 'pending_review';
CREATE INDEX idx_email_source_suggestions_inbound ON email_source_suggestions (suggested_via_inbound_id);
