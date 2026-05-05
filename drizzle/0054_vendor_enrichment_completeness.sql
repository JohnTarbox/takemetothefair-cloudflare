-- 0054: §10.2 vendor enrichment + completeness tracking.
--
-- Adds four columns to vendors:
--   enrichment_source        — last enrichment pipeline that produced content
--                              (ai_workers | scraper | manual_admin | vendor_self | mcp_create)
--   enrichment_attempted_at  — last attempt timestamp (success or failure)
--   domain_hijacked          — boolean flag for known-hijacked domain
--   completeness_score       — cached 0-100 score for sitemap quality gate
--
-- All ADDs are nullable / defaulted, safe with old code.

ALTER TABLE vendors ADD COLUMN enrichment_source TEXT;
ALTER TABLE vendors ADD COLUMN enrichment_attempted_at INTEGER;
ALTER TABLE vendors ADD COLUMN domain_hijacked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN completeness_score INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_vendors_completeness_score ON vendors(completeness_score);
CREATE INDEX idx_vendors_domain_hijacked ON vendors(domain_hijacked);

-- One-time backfill of completeness_score from current column values.
-- Rubric (sums to 100):
--   description (30) | logo_url (15) | phone-or-email (10) | website (10)
--   vendor_type (15) | products non-empty (10) | claimed (10)
-- Re-run guard: only touches rows where score is still 0 (the default), so
-- app-level recomputes that ran first are preserved.
UPDATE vendors
SET completeness_score =
  (CASE WHEN description IS NOT NULL AND TRIM(description) != '' THEN 30 ELSE 0 END) +
  (CASE WHEN logo_url IS NOT NULL AND TRIM(logo_url) != '' THEN 15 ELSE 0 END) +
  (CASE WHEN (contact_phone IS NOT NULL AND TRIM(contact_phone) != '')
          OR (contact_email IS NOT NULL AND TRIM(contact_email) != '')
        THEN 10 ELSE 0 END) +
  (CASE WHEN website IS NOT NULL AND TRIM(website) != '' THEN 10 ELSE 0 END) +
  (CASE WHEN vendor_type IS NOT NULL AND TRIM(vendor_type) != '' THEN 15 ELSE 0 END) +
  (CASE WHEN products IS NOT NULL AND products != '[]' AND TRIM(products) != '' THEN 10 ELSE 0 END) +
  (CASE WHEN claimed = 1 THEN 10 ELSE 0 END)
WHERE completeness_score = 0;
