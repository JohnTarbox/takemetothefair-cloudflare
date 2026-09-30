-- OPE-1121 Phase 2 (5/13): workflow_run_steps gains its foreign key.
--
-- inbound_email_id → inbound_emails(id) ON DELETE SET NULL. A step log is its own record.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references workflow_run_steps; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS workflow_run_steps__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE workflow_run_steps__ope1121 (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  duration_ms INTEGER,
  recorded_at INTEGER NOT NULL
);

INSERT INTO workflow_run_steps__ope1121 (id, instance_id, workflow_name, inbound_email_id, step_name, status, detail, duration_ms, recorded_at)
SELECT id, instance_id, workflow_name, inbound_email_id, step_name, status, detail, duration_ms, recorded_at FROM workflow_run_steps;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM workflow_run_steps__ope1121) = (SELECT count(*) FROM workflow_run_steps)
   AND (SELECT count(*) FROM workflow_run_steps__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE workflow_run_steps;
ALTER TABLE workflow_run_steps__ope1121 RENAME TO workflow_run_steps;

CREATE INDEX idx_workflow_run_steps_email ON workflow_run_steps (inbound_email_id);
CREATE INDEX idx_workflow_run_steps_instance ON workflow_run_steps (instance_id);
