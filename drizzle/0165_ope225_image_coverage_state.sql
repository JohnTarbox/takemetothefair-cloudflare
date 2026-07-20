-- OPE-225 — photo-coverage rails.
--
-- One row per (entity_type, entity_id): image coverage, demand tier and URL
-- health for events / vendors / venues / promoters / performers.
--
-- Why a state table rather than an `image_set_at` column on each of the five
-- entity tables: that column would have to be stamped at ~108 distinct
-- image-write sites across the main app and the MCP Worker. A rail wired at
-- only some of them under-reports silently forever, which is the exact defect
-- class this ticket family exists to catch. Instead there is ONE writer
-- (`refreshImageCoverageState`) that observes current state and reconciles.
--
-- Consequence, recorded so nobody later reads it as wall-clock truth:
-- `image_set_at` = "first OBSERVED with an image", granular to the scan
-- cadence. Rows that already had an image when the rail was installed get
-- `baseline_had_image = 1` and a NULL `image_set_at` rather than a fabricated
-- timestamp — the OPE-226 scorecard can only claim lift for images added after
-- the baseline.
--
-- Idempotent (IF NOT EXISTS): re-running against a database that already has
-- the table is a no-op, per the migration discipline in
-- docs/bulk-mutation-discipline.md.

CREATE TABLE IF NOT EXISTS image_coverage_state (
  entity_type         TEXT    NOT NULL,
  entity_id           TEXT    NOT NULL,
  slug                TEXT    NOT NULL,
  has_image           INTEGER NOT NULL DEFAULT 0,
  image_url           TEXT,
  url_health          TEXT    NOT NULL DEFAULT 'MISSING',
  image_set_at        INTEGER,
  baseline_had_image  INTEGER NOT NULL DEFAULT 0,
  first_seen_at       INTEGER NOT NULL,
  demand_impressions  INTEGER NOT NULL DEFAULT 0,
  demand_tier         TEXT    NOT NULL DEFAULT 'T4',
  checked_at          INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- The demand-ranked backlog: WHERE has_image = 0 ORDER BY demand_impressions DESC.
CREATE INDEX IF NOT EXISTS idx_image_coverage_queue
  ON image_coverage_state (has_image, demand_impressions);

-- Coverage-by-tier rollups (the metric that makes "high-traffic imageless" first-class).
CREATE INDEX IF NOT EXISTS idx_image_coverage_type_tier
  ON image_coverage_state (entity_type, demand_tier);

-- URL-health sweep: finding hotlinks now, rechecking rot in the follow-up.
CREATE INDEX IF NOT EXISTS idx_image_coverage_health
  ON image_coverage_state (url_health);

-- OPE-246 heartbeat probe for the new writer path. Seeded ENABLED because the
-- scan ships live in this PR (a dormant probe would never fire). If the scan is
-- ever gated behind a flag, set enabled_at back to NULL until the flag flips.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'image-coverage-scan',
  strftime('%s', '2026-07-20'),
  'OPE-225 photo-coverage rails — refreshImageCoverageState writes image_coverage_state.checked_at',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;
