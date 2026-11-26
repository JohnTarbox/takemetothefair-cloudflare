-- OPE-1626 — the scheduled feed reader goes live (FEED_POLLING_ENABLED "true").
--
-- promoter_event_feeds gains:
--   questions_hold   — while 1, a read still opens organizer_feed discrepancies
--                      but no question batch / operator draft is composed for
--                      the promoter's contact (feeds/batch.ts refuses).
--   disabled_reason / disabled_at — set when a feed is auto-disabled after 5
--                      consecutive failed reads, or switched off by an operator.
--   last_ok_at       — the last read that succeeded (ingested or 304); the
--                      feed-reader heartbeat probe's per-feed staleness clock.
--
-- promoter_feed_reads: one row per real read (schedule / ping / manual), the
-- newest 200 per feed kept (the writer prunes).
--
-- Applies cleanly to an EMPTY db: every new column is NULL or a default, the
-- new table starts empty, the two UPDATEs on promoter_event_feeds match no row
-- there, and the heartbeat_probes statements touch a table with no FK.

ALTER TABLE promoter_event_feeds ADD COLUMN questions_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promoter_event_feeds ADD COLUMN disabled_reason TEXT;
ALTER TABLE promoter_event_feeds ADD COLUMN disabled_at INTEGER;
ALTER TABLE promoter_event_feeds ADD COLUMN last_ok_at INTEGER;

CREATE TABLE promoter_feed_reads (
  id TEXT PRIMARY KEY NOT NULL,
  feed_id TEXT NOT NULL REFERENCES promoter_event_feeds(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  triggered_by TEXT NOT NULL,                -- schedule | ping | manual
  outcome TEXT NOT NULL,                     -- ok | not_modified | error | skipped
  http_status INTEGER,
  items_read INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 0,
  linked INTEGER NOT NULL DEFAULT 0,
  awaiting_review INTEGER NOT NULL DEFAULT 0,
  discrepancies INTEGER NOT NULL DEFAULT 0,  -- opened or replaced by this read
  third_values INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_promoter_feed_reads_feed ON promoter_feed_reads (feed_id, started_at);

-- The OHTM pilot: read automatically, review-only. Questions stay held until
-- John clears it with set_promoter_feed(questions_hold: false).
UPDATE promoter_event_feeds SET questions_hold = 1 WHERE id = '0b555459-a15f-48b5-9c6f-7fa9bd2cd182';

-- A feed already read successfully by hand starts its staleness clock there.
UPDATE promoter_event_feeds SET last_ok_at = last_read_at
WHERE last_read_at IS NOT NULL AND last_ok_at IS NULL
  AND (last_read_status IS NULL OR last_read_status NOT LIKE 'error:%');

-- OPE-246 — heartbeat probes. Everything below touches heartbeat_probes only.
-- feed-reader: any ENABLED feed with no successful read within 2x its own
-- interval reads red. Live from the ship date (polling ships on).
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'feed-reader',
  1794355200,
  'OPE-1626 — every enabled organizer feed has a successful read (ingested or 304) within 2x its poll interval',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

-- The probes seeded dormant because FEED_POLLING_ENABLED was "false" (0406,
-- 0412) start measuring on the ship date, 2026-11-11T00:00Z.
UPDATE heartbeat_probes SET enabled_at = 1794355200, updated_at = unixepoch()
WHERE probe_name IN ('feed-change-ping', 'organizer-feed-ingest') AND enabled_at IS NULL;
