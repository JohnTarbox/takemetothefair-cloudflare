-- Email send idempotency ledger (queue audit follow-up, 2026-06-16).
--
-- Cloudflare Queues are at-least-once: the email-jobs consumer can receive the
-- SAME message id again (higher `attempts`) if a send succeeded at the provider
-- but the Worker died before ack — re-sending a duplicate email. handleEmailBatch
-- now records each queue message id here AFTER a successful send and skips any id
-- already present on redelivery (at-most-once send, favoring no-duplicate while
-- never losing mail — a genuine failure isn't recorded and still retries → DLQ).
--
-- Bounded by a per-batch prune of rows older than a few days (retries exhaust in
-- hours), so the table stays small without a dedicated cron.
--
-- IF NOT EXISTS so a re-run / out-of-band create can't wedge `migrations apply`
-- (see the drizzle/0123 incident).
-- Verify not already present:  PRAGMA table_info('email_send_ledger');
CREATE TABLE IF NOT EXISTS email_send_ledger (
  message_id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  recipient TEXT,
  source TEXT,
  provider_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_send_ledger_sent_at
  ON email_send_ledger(sent_at);
