-- OPE-1172 — attach the 4 orphaned `rejected` delivery events of 2026-09-26 to
-- the ledger row they belong to, a7e640ff595e6e9f852ca25b5123dbc2
-- (auth.send-verification, status 'failed').
--
-- They landed with ledger_message_id NULL because a rejected send throws, so
-- the failed ledger row never stored a provider id to join on. The consumer
-- now joins a `rejected` event by recipient + time window instead
-- (mcp-server/src/email-delivery.ts, findRejectedSendRow); this applies the
-- same rule to the four events that arrived before it. Verified on prod
-- 2026-09-27: all four share the ledger row's recipient and fall within
-- 22:36:02 → 22:37:14 against a sent_at of 22:37:14.
--
-- Keyed on event_id AND `ledger_message_id IS NULL`, so it is idempotent and a
-- no-op on an empty database. The ledger update only fills a NULL outcome,
-- matching the consumer's never-lower rule. See docs/bulk-mutation-discipline.md.

UPDATE email_delivery_events
SET ledger_message_id = 'a7e640ff595e6e9f852ca25b5123dbc2'
WHERE ledger_message_id IS NULL
  AND status = 'rejected'
  AND event_id IN (
    '01a0dfdc-73cb-7161-98c3-2c410b625e39',
    '01a0dfdc-9cc7-7e41-9308-4e0645587580',
    '01a0dfdc-ee70-7c32-aae5-72d2be87344f',
    '01a0dfdd-8dcb-7471-b985-34bf834e0bbf'
  )
  AND EXISTS (
    SELECT 1 FROM email_send_ledger WHERE message_id = 'a7e640ff595e6e9f852ca25b5123dbc2'
  );

UPDATE email_send_ledger
SET delivery_status = 'rejected', delivery_updated_at = unixepoch()
WHERE message_id = 'a7e640ff595e6e9f852ca25b5123dbc2'
  AND delivery_status IS NULL;
