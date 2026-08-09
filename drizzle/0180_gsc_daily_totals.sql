-- OPE-345 — property-level daily totals, because gsc_search_metrics is NOT summable.
--
-- Measured 2026-08-09 against Google's own July summary email (the external
-- oracle that caught this):
--
--   oracle (Google)              9,370 clicks / 398,000 impressions
--   SUM(gsc_search_metrics)      3,305 clicks / 203,575 impressions
--   -> 64.7% of clicks missing
--
-- The cause is structural, not a bug in the ingest: gsc_search_metrics stores
-- rows dimensioned by (query, page), and GSC omits anonymized queries and the
-- long tail from dimensioned responses. Summing those cells can therefore never
-- reconstruct the property total, no matter how complete the sync is.
--
-- Grouping by DATE alone does not trigger that loss — the anonymization is
-- specific to query grouping — so this table is filled from a date-dimensioned
-- request and is the only correct source for "how many clicks did the site get".
CREATE TABLE IF NOT EXISTS gsc_daily_totals (
  site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
  date TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_url, date)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_totals_date ON gsc_daily_totals(date);

-- A6 freshness probe (48h window). The daily sync writes this table every run,
-- so a gap means the ingest stopped — which is exactly the failure that would
-- otherwise leave the dashboard quietly showing a stale, still-plausible number.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'gsc-daily-totals',
  unixepoch(),
  'OPE-345 — un-dimensioned GSC daily totals; gsc_search_metrics is not summable',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
