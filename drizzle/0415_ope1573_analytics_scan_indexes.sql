-- OPE-1573 — three full-table scans the /admin/analytics Overview tab runs on
-- every render.
--
-- Database-level D1 analytics: the 15:30Z and 17:50Z minutes on 2026-11-11, each
-- holding one /admin/analytics render that died with "D1 DB is overloaded", read
-- 1.53M and 0.97M rows against a ~150–300K/min baseline. The 17:53Z minute (seven
-- renders, the analyst's reproduction) read 11.4M. Per-query insights for
-- 17:53–17:56Z name these three as scans:
--
--   count(*) FROM vendors WHERE enhanced_profile=? AND enhanced_profile_started_at
--     >= ? AND < ?                          125 calls · 1,743,000 rows (~13.9K/call)
--   max(created_at) FROM vendor_enrichment_candidates
--                                           130 calls ·   931,450 rows (~7.2K/call)
--   count(*) FROM health_issues WHERE first_detected_at >= ?
--                                           194 calls ·   445,618 rows (~2.3K/call)
--
-- No existing index leads on any of those columns. Each index below turns its
-- query into a range seek (or a single-row read for max()).
--
-- Schema-only and idempotent; a no-op on an empty database.
CREATE INDEX IF NOT EXISTS idx_vendors_enhanced_profile_started ON vendors (enhanced_profile, enhanced_profile_started_at);
CREATE INDEX IF NOT EXISTS idx_vec_created_at ON vendor_enrichment_candidates (created_at);
CREATE INDEX IF NOT EXISTS idx_health_issues_first_detected ON health_issues (first_detected_at);
