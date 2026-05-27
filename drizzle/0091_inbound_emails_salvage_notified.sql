-- inbound_emails.salvage_notified_at — idempotency marker for the
-- "your submission was manually salvaged by admin" notification.
-- Mirrors the events.approval_notified_at pattern (drizzle/0077).
--
-- Background (analyst Item 19, 2026-05-25): when admin manually
-- creates one-or-more events from an inbound_email that the
-- workflow couldn't auto-extract (the K1LX hamfest case: 1 list-
-- page submission → 4 hand-created events), the submitter currently
-- gets no follow-up. This column gates the salvage notification so
-- it fires once per inbound_emails row no matter how many times
-- admin edits the linkage.

ALTER TABLE inbound_emails ADD COLUMN salvage_notified_at INTEGER;
