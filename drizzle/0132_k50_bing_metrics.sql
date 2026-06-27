-- K50 (2026-06-26) — Bing daily traffic totals, the durable counterpart to
-- ga4_daily_metrics so GSC + Bing search-performance are both queryable for
-- trend history. Bing's GetRankAndTrafficStats returns daily site totals
-- (impressions/clicks per day) only — not query×page — so this is a daily-
-- totals table. The API returns the full retained series in one call, so the
-- daily sync (/api/admin/analytics/gsc-metrics/sync) that upserts it also
-- backfills; no separate first-run script.
--
-- Do NOT apply out-of-band — deploy.yml's d1-migrate step owns application.
-- Verify after deploy: PRAGMA table_info('bing_daily_metrics');
CREATE TABLE IF NOT EXISTS bing_daily_metrics (
  date TEXT PRIMARY KEY,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
  updated_at INTEGER NOT NULL
);
