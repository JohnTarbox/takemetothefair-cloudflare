-- OPE-1121 Phase 2 (6/13): submission_correction_tokens gains its foreign key.
--
-- event_id → events(id) and inbound_email_id → inbound_emails(id), both ON DELETE CASCADE. A correction token for an event or email that is gone corrects nothing. idx_..._inbound is NEW: the inbound FK needs an index on the child column or every parent delete scans this table (the Phase 1 lesson).
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references submission_correction_tokens; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS submission_correction_tokens__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE submission_correction_tokens__ope1121 (
  token TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO submission_correction_tokens__ope1121 (token, event_id, inbound_email_id, expires_at, used_at, created_at)
SELECT token, event_id, inbound_email_id, expires_at, used_at, created_at FROM submission_correction_tokens;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM submission_correction_tokens__ope1121) = (SELECT count(*) FROM submission_correction_tokens)
   AND (SELECT count(*) FROM submission_correction_tokens__ope1121 c WHERE c.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM events p WHERE p.id = c.event_id)) = 0
   AND (SELECT count(*) FROM submission_correction_tokens__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE submission_correction_tokens;
ALTER TABLE submission_correction_tokens__ope1121 RENAME TO submission_correction_tokens;

CREATE INDEX idx_submission_correction_tokens_event ON submission_correction_tokens (event_id);
CREATE INDEX idx_submission_correction_tokens_expires ON submission_correction_tokens (expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_submission_correction_tokens_inbound ON submission_correction_tokens (inbound_email_id);
