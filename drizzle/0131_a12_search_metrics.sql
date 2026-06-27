-- A12 (2026-06-26) — durable GSC + GA4 search-performance time-series.
--
-- The live analytics widgets fetch GSC searchAnalytics/query and the GA4 Data
-- API per-request and never persist, so there's no history to chart WoW query
-- movement or attribute lifts to ships, and Google only retains ~16 months
-- before a window rolls off permanently. These two tables are the trend store:
--   gsc_search_metrics — one row per (site_url, date, query, page), upserted by
--     the daily MCP cron (/api/admin/analytics/gsc-metrics/sync); the last few
--     days are re-upserted because GSC revises recent dates retroactively.
--   ga4_daily_metrics  — one row per day (active users / sessions / key events).
-- First-run ~16-month backfill is driven by scripts/gsc-backfill.ts.
--
-- Do NOT apply out-of-band — deploy.yml's d1-migrate step owns application
-- (wrangler records applied filenames in d1_migrations). Verify after deploy:
--   PRAGMA table_info('gsc_search_metrics');
--   PRAGMA table_info('ga4_daily_metrics');
CREATE TABLE IF NOT EXISTS gsc_search_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_search_metrics_unique ON gsc_search_metrics (site_url, date, query, page);
CREATE INDEX IF NOT EXISTS idx_gsc_search_metrics_query_date ON gsc_search_metrics (query, date);
CREATE INDEX IF NOT EXISTS idx_gsc_search_metrics_page_date ON gsc_search_metrics (page, date);
CREATE INDEX IF NOT EXISTS idx_gsc_search_metrics_date ON gsc_search_metrics (date);

CREATE TABLE IF NOT EXISTS ga4_daily_metrics (
  date TEXT PRIMARY KEY,
  active_users INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  key_events INTEGER NOT NULL DEFAULT 0,
  property TEXT NOT NULL DEFAULT 'ga4',
  updated_at INTEGER NOT NULL
);
