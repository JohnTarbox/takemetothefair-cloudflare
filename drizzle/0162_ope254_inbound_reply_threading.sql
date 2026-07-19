-- OPE-254 Defect 2 — persist inbound reply threading headers.
--
-- `In-Reply-To` / `References` are parsed by PostalMime at receive time and,
-- before this, consumed ONLY by the intent fast-path (isReplyToOurThread) and
-- then dropped. Per-intent handlers receive the stored inbound_emails row, not
-- the parsed headers, so they had no way to thread a reply back to the message
-- it answers.
--
-- The photo-intake reply→resolve path needs exactly that: when John replies to
-- a `photo-intake-unresolved` hold naming the fair, match the reply's
-- References chain (which — via OPE-163 — carries the ORIGINAL photo email's
-- Message-ID) against inbound_emails.message_id to find the held parent(s).
--
-- Two nullable TEXT columns, verbatim header values. No index: the lookup is
-- message_id IN (<ids parsed from these>), and message_id already has the
-- uq_inbound_emails_message_id unique index.
ALTER TABLE inbound_emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE inbound_emails ADD COLUMN email_references TEXT;
