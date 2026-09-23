-- OPE-1121 Phase 2 (8/13): email_delivery_events gains its foreign key.
--
-- ledger_message_id → email_send_ledger(message_id) ON DELETE SET NULL. AFTER 0308 on purpose (see there). Note: pruneEmailLedger (queue-consumers.ts, 365-day TTL) now nulls this column on the delivery rows of pruned sends, so those rows join the idx_..._unmatched set. Nothing reads that set as an alert today (grep: the only writer of ledger_message_id is email-delivery.ts:244). idx_..._ledger is NEW, for the same reason as 0313.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references email_delivery_events; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS email_delivery_events__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE email_delivery_events__ope1121 (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  recipient TEXT,
  sender TEXT,
  subject TEXT,
  terminal INTEGER,
  smtp_status_code TEXT,
  smtp_response TEXT,
  bounce_type TEXT,
  bounce_classification TEXT,
  event_timestamp INTEGER,
  received_at INTEGER NOT NULL,
  ledger_message_id TEXT REFERENCES email_send_ledger(message_id) ON DELETE SET NULL
);

INSERT INTO email_delivery_events__ope1121 (event_id, event_type, status, provider_message_id, recipient, sender, subject, terminal, smtp_status_code, smtp_response, bounce_type, bounce_classification, event_timestamp, received_at, ledger_message_id)
SELECT event_id, event_type, status, provider_message_id, recipient, sender, subject, terminal, smtp_status_code, smtp_response, bounce_type, bounce_classification, event_timestamp, received_at, ledger_message_id FROM email_delivery_events;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM email_delivery_events__ope1121) = (SELECT count(*) FROM email_delivery_events)
   AND (SELECT count(*) FROM email_delivery_events__ope1121 c WHERE c.ledger_message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM email_send_ledger p WHERE p.message_id = c.ledger_message_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE email_delivery_events;
ALTER TABLE email_delivery_events__ope1121 RENAME TO email_delivery_events;

CREATE INDEX idx_email_delivery_events_provider_message_id ON email_delivery_events(provider_message_id);
CREATE INDEX idx_email_delivery_events_received_at ON email_delivery_events(received_at);
CREATE INDEX idx_email_delivery_events_recipient ON email_delivery_events(recipient);
CREATE INDEX idx_email_delivery_events_status ON email_delivery_events(status);
CREATE INDEX idx_email_delivery_events_unmatched ON email_delivery_events(received_at) WHERE ledger_message_id IS NULL;
CREATE INDEX idx_email_delivery_events_ledger ON email_delivery_events(ledger_message_id);
