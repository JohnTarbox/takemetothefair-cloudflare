-- PR-B (May 2026): add message_id column + partial unique index to
-- inbound_emails so the email() entrypoint can dedup re-delivered raw
-- messages via INSERT ... ON CONFLICT DO NOTHING.
--
-- The Message-ID header (RFC 5322 §3.6.4) is the natural dedup key:
-- the sending MTA generates it, and any legitimate re-delivery (e.g.,
-- our Worker crashed mid-handler before ack) carries the same value.
-- Senders that omit it (rare in practice, but possible from automated
-- systems) skip dedup and behave as before.
--
-- Partial-unique semantics: NULL message_id values are exempt from the
-- uniqueness constraint. SQLite already treats NULLs as distinct in a
-- UNIQUE index, but the explicit WHERE clause makes the intent visible
-- to readers and matches drizzle's schema definition.
--
-- Idempotent: ADD COLUMN errors on re-apply if the column already
-- exists, which is what we want — running migrations twice should
-- fail loudly, not silently no-op.

ALTER TABLE inbound_emails ADD COLUMN message_id TEXT;

CREATE UNIQUE INDEX uq_inbound_emails_message_id
  ON inbound_emails(message_id)
  WHERE message_id IS NOT NULL;
