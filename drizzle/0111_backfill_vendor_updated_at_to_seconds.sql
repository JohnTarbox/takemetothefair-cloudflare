-- Mirrors drizzle/0045: a subset of `vendors` rows were historically written
-- with ms-epoch `updated_at` values instead of the seconds-epoch convention
-- every `mode: "timestamp"` column expects. Drizzle reads such a row as
-- `new Date(updated_at * 1000)`, so a ~1.78e12 ms value becomes a ~1.78e15
-- ms Date, which is year ~58308. Most visible at:
--
--   * /sitemap.xml: MAX(updated_at) on vendors was emitting a year-58308
--     lastmod (a defensive guard in src/lib/sitemap-lastmod.ts has been
--     correcting this at the index level; per-URL entries inside
--     /sitemap-vendors.xml still surface the corrupted dates).
--
-- The guard `> 100000000000` (1e11) makes this re-runnable safely: any
-- legitimate seconds-epoch value today sits ~1.78e9, well below the
-- threshold. Once this migration is applied successfully, the
-- correctMsOverflow() helper in src/lib/sitemap-lastmod.ts is removed in
-- the same PR.
--
-- Pre-flight audit (read-only) recommended before apply:
--   SELECT COUNT(*) FROM vendors WHERE updated_at > 100000000000;
-- Expected ~86 rows per the memory of the May 2026 divergence.
--
-- IMPORTANT: take a backup before applying:
--   npm run db:backup

UPDATE vendors
   SET updated_at = updated_at / 1000
 WHERE updated_at > 100000000000;
