-- OPE-1633 — feed analytics 2/5: feed health flags (measure and flag only).
--
-- promoter_feed_reads gains, on every good (outcome='ok') read:
--   title_filled / start_filled / venue_filled — items in the read with a
--                    non-empty title, a start date, a venue; the format-drift
--                    check compares each share against the feed's own baseline.
--   unmappable     — items the parser skipped as unmappable (read.meta).
-- All NULL on older rows and on 304 / error / skipped rows, so a baseline only
-- ever averages reads that measured the field.
--
-- feed_health_flags: one OPEN row per (feed, check) while the check trips;
-- `cleared_at` is set when a later evaluation is back within bounds. A cleared
-- row stays as history; the next trip opens a new row.
--
-- Applies cleanly to an EMPTY db: four nullable columns, a new empty table, and
-- a heartbeat_probes upsert on a table with no FK.

ALTER TABLE promoter_feed_reads ADD COLUMN title_filled INTEGER;
ALTER TABLE promoter_feed_reads ADD COLUMN start_filled INTEGER;
ALTER TABLE promoter_feed_reads ADD COLUMN venue_filled INTEGER;
ALTER TABLE promoter_feed_reads ADD COLUMN unmappable INTEGER;

CREATE TABLE feed_health_flags (
  id TEXT PRIMARY KEY NOT NULL,
  feed_id TEXT NOT NULL REFERENCES promoter_event_feeds(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL,          -- freshness | volume_drop | format_drift | inclusion_swing
  observed REAL,
  baseline REAL,
  detail TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE UNIQUE INDEX idx_feed_health_flags_open
  ON feed_health_flags (feed_id, check_name) WHERE cleared_at IS NULL;
CREATE INDEX idx_feed_health_flags_feed ON feed_health_flags (feed_id, first_seen_at);

-- OPE-246 — heartbeat probes. Everything below touches heartbeat_probes only.
-- feed-health-eval: the hourly feed poll writes one info row per run under
-- `feeds:health-eval` after evaluating every enabled feed. The flags table is
-- rightly quiet when every feed is healthy, so the evidence is the run row.
-- Live from the ship date: FEED_POLLING_ENABLED is "true" (OPE-1626).
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'feed-health-eval',
  unixepoch(),
  'OPE-1633 — the hourly feed poll evaluated every enabled feed''s health (freshness, volume, format, inclusion)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
