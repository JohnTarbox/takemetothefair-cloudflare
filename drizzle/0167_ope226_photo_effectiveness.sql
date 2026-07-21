-- OPE-226 — photo-effectiveness scorecard: the daily coverage snapshot.
--
-- `image_coverage_state` (OPE-225) is current-state only: one upserted row per
-- (entity_type, entity_id), so yesterday's coverage is overwritten every scan.
-- Scope §1 ("coverage trend by tier") and §4 ("rot/hotlink counts, trended")
-- are therefore unanswerable from it. This append-only sibling holds the
-- history, at the exact grain the scorecard reports.
--
-- `scan_complete` is stored with the numbers on purpose. The 2026-07-21 06:01Z
-- production scan wrote events + part of vendors and stopped; venues, promoters
-- and performers were never written, and an absent type renders as 0/0 — which
-- reads as "measured and empty" rather than "not measured". The flag is what
-- lets the scorecard tell those apart.
--
-- Idempotent per docs/bulk-mutation-discipline.md.
CREATE TABLE IF NOT EXISTS photo_coverage_daily (
  date TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  demand_tier TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  with_image INTEGER NOT NULL DEFAULT 0,
  hotlinked INTEGER NOT NULL DEFAULT 0,
  unreachable INTEGER NOT NULL DEFAULT 0,
  added_since_baseline INTEGER NOT NULL DEFAULT 0,
  scan_complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (date, entity_type, demand_tier)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_photo_coverage_daily_type_date
  ON photo_coverage_daily (entity_type, date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_photo_coverage_daily_date
  ON photo_coverage_daily (date);
--> statement-breakpoint
-- OPE-246 heartbeat probe for the snapshot writer that ships in this PR.
-- enabled_at = ship date: the writer runs inside the existing daily photo
-- coverage scan, so it should produce a row every day from today. If it stops,
-- the probe escalates through the OPE-75 digest instead of the trend quietly
-- flat-lining at its last value.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'photo-coverage-snapshot',
  strftime('%s', '2026-07-21'),
  'OPE-226 scorecard — persistPhotoCoverageSnapshot writes photo_coverage_daily once per scan',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;
