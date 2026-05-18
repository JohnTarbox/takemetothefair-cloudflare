-- 2026-05-18: persist auto-reply attribution on inbound_emails so dedup
-- hits, no-URL fallbacks, and extract/submit failures are distinguishable
-- after the fact. Before this migration, only the workflow's return value
-- (visible in the CF Workflows dashboard) recorded which replyKind fired —
-- the inbound_emails row carried only `status` (replied/forwarded/failed),
-- which conflated several different "replied" outcomes.
--
-- Columns added:
--
--   reply_kind TEXT — the ReplyKind that the send-reply step used.
--     Values mirror src/email-handlers/types.ts ReplyKind:
--       ok, no-url, extract-failed, submit-failed, already-exists,
--       correction-ack/applied/rejected/needs-info,
--       support-ack, press-ack/handled/needs-info,
--       unsubscribe-ack.
--     NULL on rows from before this migration (no backfill — historical
--     state can only be reconstructed via the workflow dashboard).
--
--   resulting_event_id TEXT — points at the event this inbound resolved
--     against. Dual-purpose, discriminated by reply_kind:
--       reply_kind = 'ok'           → the NEW event we just created
--       reply_kind = 'already-exists' → the EXISTING event the dedup
--                                       check matched
--       reply_kind anything else    → NULL (no event involved)
--     NULL on historical rows.
--
-- Idempotent additive migration; no backfill. Future inbounds will
-- populate from the mark-done step in InboundEmailWorkflow.run.

ALTER TABLE inbound_emails ADD COLUMN reply_kind TEXT;
ALTER TABLE inbound_emails ADD COLUMN resulting_event_id TEXT;

-- Index for "show me all dedup hits in the last 7d" queries via the
-- new admin filter. Partial: only index non-NULL values so historical
-- rows don't bloat the index.
CREATE INDEX idx_inbound_emails_reply_kind
  ON inbound_emails(reply_kind)
  WHERE reply_kind IS NOT NULL;
