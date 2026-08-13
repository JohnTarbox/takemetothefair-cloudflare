-- OPE-309 (assurance audit A5 + A7/A8 third instance).
--
-- Two tables, one principle: a feed needs something that notices when it goes
-- stale, and that something has to be able to tell "quiet" from "dead".

-- ── A5: Bing Webmaster API liveness ────────────────────────────────────────
--
-- Mirrors ga4_liveness_log, with its calibration bug NOT copied.
--
-- Measured 2026-08-12 before writing this: ga4_liveness_log holds 97 rows
-- spanning 2026-05-06 -> 2026-08-12 and every single one is 'degraded', with
-- data_age_seconds = 30.0h on every row. GA4 is healthy. The check runs at
-- 06:00Z, GA4's newest complete day is "yesterday", and the age is anchored at
-- MIDNIGHT of that date -- so the minimum observable age is 30h against a 24h
-- degraded threshold. Green is unreachable by construction, and the paired
-- alert has fired 96 times since 2026-05-07 without describing a real defect.
--
-- Here the age is measured from the END of the newest data day, so "yesterday's
-- row at 06:00Z" is 6h old and green, one missing day is 30h and degraded, two
-- is 54h and critical. See src/lib/bing-liveness.ts.
--
-- `error` has no counterpart on the GA4 table: an unreachable API (our
-- credential) and a stale feed (Bing's pipeline) have different owners, and
-- collapsing both into a null date discards the only field that distinguishes
-- them.
CREATE TABLE IF NOT EXISTS bing_liveness_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  max_data_date TEXT,
  data_age_seconds INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  alert_fired INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_bing_liveness_log_checked_at ON bing_liveness_log(checked_at);

-- ── A7/A8 third instance: site-health refresh proof-of-execution ───────────
--
-- refreshIssues() writes health_issues rows, so the obvious probe is output
-- freshness. Production says that probe would be wrong: the three sources this
-- cron owns (BING_SCAN / BING_SITEMAP / GSC_SITEMAP) have written ZERO rows in
-- the entire life of health_issues (639 rows: 638 GSC_URL_INSPECTION + 1
-- EMAIL_DELIVERY). Verified live -- Bing's GetCrawlIssues returns [] and all 8
-- sitemaps report Success. A healthy site produces no issue rows, forever.
--
-- The RUN is periodic even though the OUTPUT is event-driven, so the run is
-- what gets stamped. Single row, id='default', mirroring
-- recommendation_scan_state.
CREATE TABLE IF NOT EXISTS site_health_refresh_state (
  id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_inserted INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT 0,
  last_resolved INTEGER NOT NULL DEFAULT 0,
  -- How many collectors THREW on the last run. A source that failed is skipped
  -- by the resolve loop, because "we could not look" must never be recorded as
  -- "fixed" (the OPE-244 false-resolve family, third mechanism).
  last_failed_sources INTEGER NOT NULL DEFAULT 0,
  last_failed_source_names TEXT
);

-- ── Probe registrations (OPE-246 first-evidence discipline) ────────────────
--
-- Both enabled now: neither is behind a feature flag, and both are fed by the
-- existing 06:00Z daily batch, so first unattended evidence lands tomorrow
-- morning -- inside the 48h window, so neither can false-fire in the gap.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'bing-liveness',
  unixepoch(),
  'OPE-309 A5 - daily Bing Webmaster ping; evidence is the freshest GREEN row, so a persistently-critical Bing and a dead prober both read RED',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'site-health-refresh',
  unixepoch(),
  'OPE-309 A7/A8 - proof the daily site-health refresh executed; probes the RUN, not the issue rows (a clean site writes none)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
