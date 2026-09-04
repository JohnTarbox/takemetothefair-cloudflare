-- OPE-768 — model correspondence as conversations, not a pile of envelopes.
--
-- support_obligations.inbound_email_id is UNIQUE per email, so a person who
-- writes twice opens two obligations and reads as two waiting customers.
-- Heather Santiago sat as two open rows for eight weeks after a single reply
-- had discharged both. `in_reply_to` was captured on 21 rows — naming our OWN
-- message-id on 7, a mathematically exact "this is mid-conversation" test — and
-- was consulted nowhere.
--
-- Nullable, with NO backfill in this migration, and that is deliberate:
--  * only 21 of 431 rows carry in_reply_to, so any backfill of the rest is a
--    heuristic, and a heuristic belongs in a reviewable job that REPORTS its
--    basis counts — not silently inside a schema migration;
--  * NULL therefore means "row predates threading", which is a different and
--    honest claim from "this message starts a thread" (thread_basis='new').
--
-- Safe on an EMPTY database: pure ALTERs, no FK-bearing inserts, nothing to
-- abort CI's fresh-D1 migration run.
ALTER TABLE inbound_emails ADD COLUMN thread_id TEXT;
ALTER TABLE inbound_emails ADD COLUMN thread_position INTEGER;
ALTER TABLE inbound_emails ADD COLUMN thread_basis TEXT;

-- "give me the whole conversation" is the read this exists for.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_thread
  ON inbound_emails (thread_id, received_at)
  WHERE thread_id IS NOT NULL;
