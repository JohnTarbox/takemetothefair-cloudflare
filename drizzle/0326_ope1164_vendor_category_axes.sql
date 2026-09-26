-- OPE-1164 — split vendor_type into three axes, and watch for new values weekly.
--
-- 1. Three nullable columns on vendors. ADD COLUMN only: no rebuild (vendors is
--    a parent table), and vendor_type is untouched — it is still what the site
--    renders. The backfill is a separate, John-approved data pass.
ALTER TABLE vendors ADD COLUMN sells_category TEXT;
ALTER TABLE vendors ADD COLUMN business_sector TEXT;
ALTER TABLE vendors ADD COLUMN vendor_identity TEXT;

-- 2. Every distinct value ever seen per field, with when the watch first saw it.
CREATE TABLE IF NOT EXISTS vendor_category_values (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (field, value)
);

-- 3. One row per weekly run and field: the new values and whether it alerted.
CREATE TABLE IF NOT EXISTS vendor_category_watch_runs (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  field TEXT NOT NULL,
  new_count INTEGER NOT NULL,
  new_values TEXT NOT NULL DEFAULT '[]',
  threshold INTEGER NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vendor_category_watch_runs_run_at ON vendor_category_watch_runs(run_at);

-- 4. Thresholds (alert when MORE than this many new values in a week), tunable
--    without a deploy. Ticket's suggested start: any new value in the three
--    new fields (0), more than 5 per week in vendor_type.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES ('vendor_category_new_axis_max', 0, 'values',
  'OPE-1164 - weekly watch alerts when MORE than this many never-seen values appear in a week in sells_category / business_sector / vendor_identity.', unixepoch())
ON CONFLICT(key) DO NOTHING;
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES ('vendor_category_new_vendor_type_max', 5, 'values',
  'OPE-1164 - weekly watch alerts when MORE than this many never-seen vendor_type values appear in a week.', unixepoch())
ON CONFLICT(key) DO NOTHING;

-- 5. Heartbeat probe for the weekly watch (OPE-246), armed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('vendor-category-watch', unixepoch(),
  'OPE-1164 - the Monday vendor-category watch writes one vendor_category_watch_runs row per field every week (zero new values included). Window 8 days.',
  unixepoch())
ON CONFLICT(probe_name) DO NOTHING;
