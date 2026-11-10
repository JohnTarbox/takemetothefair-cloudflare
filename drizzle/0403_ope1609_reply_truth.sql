-- OPE-1609: inbound 7f761f2a had its ack withheld by the zero-confidence guard
-- but was stored as answered. Nothing was sent, and its support obligation is
-- still open. One row, guarded on the exact false state, so it is a no-op on an
-- empty database and if someone has replied in the meantime (reply_kind='manual').
UPDATE inbound_emails
SET status = 'awaiting_human',
    reply_kind = 'support-ack-suppressed:classifier-unclear-zero-confidence'
WHERE id = '7f761f2a-f179-47b9-aa98-42f63003cf03'
  AND status = 'replied'
  AND reply_kind = 'support-ack';

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'replied-ledger-check',
  unixepoch(),
  'OPE-1609 — the hourly check that a replied row has a ledger row; one info row per run',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
