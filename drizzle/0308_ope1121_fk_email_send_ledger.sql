-- OPE-1121 Phase 2 (1/13): email_send_ledger gains its foreign key.
--
-- inbound_email_id → inbound_emails(id) ON DELETE SET NULL. A ledger row is its own record of a send; losing the inbound it answered must not delete it. FIRST of the 13 on purpose: email_delivery_events gains an FK to THIS table in 0315, after which rebuilding this table would DROP a parent and fire SET NULL on every delivery row.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references email_send_ledger; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS email_send_ledger__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE email_send_ledger__ope1121 (
  message_id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  recipient TEXT,
  source TEXT,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  subject TEXT,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  provider TEXT,
  body_html TEXT,
  body_text TEXT,
  delivery_status TEXT,
  delivery_updated_at INTEGER,
  delivery_detail TEXT
);

INSERT INTO email_send_ledger__ope1121 (message_id, sent_at, recipient, source, provider_message_id, status, error, subject, inbound_email_id, provider, body_html, body_text, delivery_status, delivery_updated_at, delivery_detail)
SELECT message_id, sent_at, recipient, source, provider_message_id, status, error, subject, inbound_email_id, provider, body_html, body_text, delivery_status, delivery_updated_at, delivery_detail FROM email_send_ledger;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM email_send_ledger__ope1121) = (SELECT count(*) FROM email_send_ledger)
   AND (SELECT count(*) FROM email_send_ledger__ope1121 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE email_send_ledger;
ALTER TABLE email_send_ledger__ope1121 RENAME TO email_send_ledger;

CREATE INDEX idx_email_send_ledger_delivery_status ON email_send_ledger(delivery_status);
CREATE INDEX idx_email_send_ledger_inbound ON email_send_ledger(inbound_email_id);
CREATE INDEX idx_email_send_ledger_provider_message_id ON email_send_ledger(provider_message_id);
CREATE INDEX idx_email_send_ledger_recipient ON email_send_ledger(recipient);
CREATE INDEX idx_email_send_ledger_sent_at ON email_send_ledger(sent_at);
CREATE INDEX idx_email_send_ledger_status ON email_send_ledger(status);
