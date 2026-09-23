-- OPE-1121 Phase 2 (3/13): support_obligations gains its foreign key.
--
-- inbound_email_id → inbound_emails(id), NO ACTION. The approved plan said SET NULL, but this column is NOT NULL UNIQUE, so SET NULL could never succeed; it would only turn a parent delete into a confusing constraint error. NO ACTION says the same thing plainly: an email we still owe a reply on cannot be deleted. No code path deletes inbound_emails today (grep across app, MCP, packages).
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references support_obligations; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS support_obligations__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE support_obligations__ope1121 (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES inbound_emails(id),
  from_address TEXT NOT NULL,
  subject TEXT,
  classified_confidence REAL,
  opened_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at INTEGER,
  closed_by TEXT,
  close_note TEXT
);

INSERT INTO support_obligations__ope1121 (id, inbound_email_id, from_address, subject, classified_confidence, opened_at, status, closed_at, closed_by, close_note)
SELECT id, inbound_email_id, from_address, subject, classified_confidence, opened_at, status, closed_at, closed_by, close_note FROM support_obligations;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM support_obligations__ope1121) = (SELECT count(*) FROM support_obligations)
   AND (SELECT count(*) FROM support_obligations__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE support_obligations;
ALTER TABLE support_obligations__ope1121 RENAME TO support_obligations;

CREATE INDEX idx_support_obligations_status ON support_obligations(status, opened_at);
