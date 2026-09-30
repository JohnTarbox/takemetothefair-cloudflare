-- OPE-1226 — close support obligations a person has already answered.
--
-- Until now only `resolve_support_obligation` (manual) closed an obligation,
-- so answered ones stayed `open`. Pre-flight in prod 2026-09-30: 54 open, of
-- which 32 have a `reply:manual*` send (status 'sent') on the obligation's own
-- inbound message and 5 more on the same thread, sent after the obligation
-- opened — 37 rows. `reply_to_inbound_email` now closes them as it sends; this
-- backfills the ones already answered.
--
-- NARROW on purpose: the message or its thread only. A manual reply that
-- matches merely by recipient address can be about another conversation, so
-- those rows stay open (list_support_obligations still flags them
-- `answered_not_closed`).
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer — one statement, applied once by the deploy's migrate step.
--   idempotent    — only `status = 'open'` rows match; a re-run changes 0.
--                   No-op on an empty (CI) database.
--   read-back     — expect ≈37 changed; afterwards 0 open rows with such a reply.
--   rollback      — UPDATE support_obligations SET status = 'open',
--                   closed_at = NULL, closed_by = NULL, close_note = NULL
--                   WHERE closed_by = 'auto:reply-manual-backfill';
UPDATE support_obligations
SET status = 'answered',
    closed_at = unixepoch(),
    closed_by = 'auto:reply-manual-backfill',
    close_note = 'OPE-1226 backfill: a reply:manual* send on this message or its thread, after the obligation opened.'
WHERE status = 'open'
  AND (
    EXISTS (
      SELECT 1 FROM email_send_ledger l
      WHERE l.inbound_email_id = support_obligations.inbound_email_id
        AND l.source LIKE 'reply:manual%'
        AND l.status = 'sent'
        AND l.sent_at >= support_obligations.opened_at
    )
    OR EXISTS (
      SELECT 1
      FROM email_send_ledger l
      JOIN inbound_emails answered ON answered.id = l.inbound_email_id
      JOIN inbound_emails owed ON owed.id = support_obligations.inbound_email_id
      WHERE owed.thread_id IS NOT NULL
        AND answered.thread_id = owed.thread_id
        AND l.source LIKE 'reply:manual%'
        AND l.status = 'sent'
        AND l.sent_at >= support_obligations.opened_at
    )
  );
