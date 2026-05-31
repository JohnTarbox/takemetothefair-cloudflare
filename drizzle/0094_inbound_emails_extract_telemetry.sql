-- inbound_emails extract telemetry: three additive columns so the workflow
-- can persist what the AI actually received and why extraction failed.
-- Today (pre-K7.4) the mark-done step writes fetch_method + extraction_method
-- but only on SUCCESS — failure paths throw before mark-done so we can't
-- tell what the AI saw. After this migration the workflow writes a
-- persist-extract-context step AFTER the URL fetch and BEFORE the AI call,
-- and the failure-path catches stamp extract_fail_reason.
--
-- analyst K7 Tier 1, 2026-05-31. Surfaced by Carolyn's moose-lottery
-- submission (inbound fe65fb77): scrapeable page, AI returned zero events,
-- hard-fail with no record of what was actually fed in.
--
-- Columns:
--   extract_fail_reason       — categorical: 'zero-events' | 'thin-content'
--                                | 'parse-error' | 'ai-timeout' | 'other'.
--                                Set on failure paths only; NULL on success
--                                and on submit rows that don't go through
--                                AI extraction (json-ld direct, free-text
--                                paths). Empty distribution today; filled
--                                going forward.
--   content_sha256_first16    — first 16 hex chars of SHA-256 of the
--                                content sent to the AI. Cheap cluster key
--                                so /admin/source-quality can find pages
--                                that consistently fail extraction. NULL on
--                                pre-K7 rows.
--   content_length_chars      — length in chars of content sent to the AI.
--                                Lets the source-quality dashboard
--                                distinguish thin-content (page returned
--                                <2KB) from rich-content extract failures.
--                                NULL on pre-K7 rows.
--
-- All three are nullable + no default — additive only, no backfill needed.
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS; pre-flight check that
-- the columns don't already exist before applying:
--   PRAGMA table_info('inbound_emails');

ALTER TABLE inbound_emails ADD COLUMN extract_fail_reason TEXT;
ALTER TABLE inbound_emails ADD COLUMN content_sha256_first16 TEXT;
ALTER TABLE inbound_emails ADD COLUMN content_length_chars INTEGER;

-- Index supports the /admin/source-quality query "which content hashes
-- consistently fail" (group by hash, count where fail_reason IS NOT NULL).
-- Partial index keeps it small — the bulk of inbound rows have NULL hash.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_content_hash
  ON inbound_emails(content_sha256_first16)
  WHERE content_sha256_first16 IS NOT NULL;
