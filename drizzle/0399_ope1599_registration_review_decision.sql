-- OPE-1599 — the outcome of an operator's review of a self-registered vendor on
-- /admin/claims: LOOKS_REAL, SUSPENDED or SPAM. reviewed_at / reviewed_by already
-- exist on this table (drizzle/0169). NULL means the row has not been reviewed.
ALTER TABLE vendor_claim_evidence ADD COLUMN review_decision TEXT;
