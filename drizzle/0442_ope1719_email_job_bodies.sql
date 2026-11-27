-- OPE-1719 — "claim check" store for email-jobs Queues messages.
--
-- Cloudflare Queues refuses a message over 128,000 bytes (error 10204). The
-- Nov 27 weekend newsletter (88,126 chars of HTML) became a 136,334-byte
-- per-recipient message and was refused on both send attempts; the
-- cpi:stale-red digest hit the same limit on 11-08 and 11-11. A producer now
-- writes an oversized body here and enqueues only its id (`bodyRef`); the MCP
-- consumer reads it back, sends, ledgers (email_send_ledger keeps its own copy
-- of the body) and deletes the row. Leftovers are pruned after 14 days.
--
-- Purely additive and empty at creation, so it is a no-op on a fresh D1.
-- Rollback: DROP TABLE email_job_bodies; (only after no producer spills —
-- an in-flight message with a bodyRef would then fail to resolve and DLQ.)
CREATE TABLE IF NOT EXISTS email_job_bodies (
  id TEXT PRIMARY KEY NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_job_bodies_created_at ON email_job_bodies (created_at);
