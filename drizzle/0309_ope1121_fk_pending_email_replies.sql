-- OPE-1121 Phase 2 (2/13): pending_email_replies gains its foreign key.
--
-- inbound_email_id → inbound_emails(id) ON DELETE CASCADE. A queued reply to an email that no longer exists has nothing to reply to.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references pending_email_replies; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS pending_email_replies__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE pending_email_replies__ope1121 (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
  to_address TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  requested_by TEXT,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT,
  sent_message_id TEXT
);

INSERT INTO pending_email_replies__ope1121 (id, inbound_email_id, to_address, subject, body_text, requested_by, requested_at, status, reviewed_by, reviewed_at, review_note, sent_message_id)
SELECT id, inbound_email_id, to_address, subject, body_text, requested_by, requested_at, status, reviewed_by, reviewed_at, review_note, sent_message_id FROM pending_email_replies;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM pending_email_replies__ope1121) = (SELECT count(*) FROM pending_email_replies)
   AND (SELECT count(*) FROM pending_email_replies__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE pending_email_replies;
ALTER TABLE pending_email_replies__ope1121 RENAME TO pending_email_replies;

CREATE INDEX idx_pending_email_replies_inbound ON pending_email_replies(inbound_email_id);
CREATE INDEX idx_pending_email_replies_status ON pending_email_replies(status, requested_at);
