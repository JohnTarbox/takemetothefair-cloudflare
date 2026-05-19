-- 2026-05-19 (A5): tracks which fetch path produced the URL content for
-- each email-submission inbound row. Values:
--   'standard'         — default fetch with browser-like UA succeeded
--   'browser-rendering' — standard fetch failed (401/403/429/network),
--                        Cloudflare Browser Rendering REST API succeeded
--                        as fallback (managed headless Chrome bypasses
--                        the WAF user-agent blocks that defeat raw fetch)
--   'failed'           — both paths failed; row has status='failed'
-- NULL on pre-A5 rows (the column was added after the pipeline went live;
-- backfill would be guessing).
--
-- No index — read-only analytics column, low cardinality, queries filter
-- on (to_address, fetch_method) already covered by idx_inbound_emails_received_at
-- for the time-bounded subset.

ALTER TABLE inbound_emails ADD COLUMN fetch_method TEXT;
