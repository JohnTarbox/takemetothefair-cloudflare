-- OPE-68 (inbound-email attachment OCR, 2026-07-03) — hand-authored per the
-- OPE-21 migration workflow (numbering owned by the orchestrator; deploy applies
-- via `wrangler d1 migrations apply` by filename — no meta snapshot needed).
--
-- Adds inbound_emails.attachment_refs: a nullable JSON array of
-- {key,name,mimeType,size} objects describing poster/PDF attachments captured
-- to R2 (the existing mmatf-vendor-assets bucket) at email receive-time. The
-- inbound-email Workflow reads these refs, OCRs each via env.AI.toMarkdown, and
-- feeds the resulting markdown text into the event-extraction pipeline. NULL on
-- all pre-OPE-68 rows and on messages that had no image/PDF attachments (or
-- where the best-effort R2 capture failed).
--
-- Rollback (SQLite pre-3.35 can't DROP COLUMN cleanly across all envs; leaving
-- the nullable column in place is harmless — older code never reads it):
--   -- no-op.

ALTER TABLE `inbound_emails` ADD COLUMN `attachment_refs` text;
