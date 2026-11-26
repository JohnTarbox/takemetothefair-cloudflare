-- OPE-1635 — feed analytics 4/5: safe rule changes.
--
-- 1. promoter_feed_item_snapshots: one row per DISTINCT version of a feed item
--    (by content_hash), written by the ingest, newest 10 per item. Seeded from
--    each item's current snapshot so the corpus starts whole.
-- 2. feed_rule_changes: the change log for inclusion-rule / matcher changes,
--    with feed-quality metrics at the change and 7 days on (filled by the MCP
--    hourly cron). First entry: OPE-1629 (#1780, merged 2026-11-12T15:20:50Z),
--    backfilled — its "before" metrics were never captured, and it says so.
-- 3. Two heartbeat probes (OPE-246), enabled at ship.
--
-- Additive only: two CREATE TABLE IF NOT EXISTS, INSERT … SELECT (no rows on an
-- empty database), INSERT OR IGNORE of a fixed id with no foreign key, and the
-- probe seeds. Deletes nothing.

CREATE TABLE IF NOT EXISTS promoter_feed_item_snapshots (
  id TEXT PRIMARY KEY,
  feed_item_id TEXT NOT NULL REFERENCES promoter_feed_items(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_item_snapshots_hash
  ON promoter_feed_item_snapshots (feed_item_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_feed_item_snapshots_item
  ON promoter_feed_item_snapshots (feed_item_id, captured_at);

INSERT OR IGNORE INTO promoter_feed_item_snapshots
  (id, feed_item_id, feed_id, content_hash, snapshot, captured_at)
SELECT lower(hex(randomblob(16))), id, feed_id, content_hash, snapshot, last_seen_at
FROM promoter_feed_items
WHERE snapshot IS NOT NULL AND content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_rule_changes (
  id TEXT PRIMARY KEY,
  changed_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inclusion', 'matcher', 'both')),
  pr TEXT,
  ope_id TEXT,
  summary TEXT NOT NULL,
  backtest TEXT,
  metrics_before TEXT,
  metrics_before_note TEXT,
  after_due_at INTEGER NOT NULL,
  metrics_after TEXT,
  metrics_after_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_rule_changes_changed ON feed_rule_changes (changed_at);

INSERT OR IGNORE INTO feed_rule_changes
  (id, changed_at, kind, pr, ope_id, summary, backtest, metrics_before, metrics_before_note,
   after_due_at, metrics_after, metrics_after_at, created_at)
VALUES (
  'ope1629-pr1780',
  1794496850,
  'inclusion',
  '#1780',
  'OPE-1629',
  'Feed inclusion keeps public markets that mention kids: market/bazaar/flea/antique/expo/craft title includes, and a program word in the DESCRIPTION drops only alongside a program signal (registration, an age or grade band, a session or class schedule).',
  'Backfilled by OPE-1635 from the labelled CI fixture (the 2026-11-11 TEC reads + prod reviews): baseline = pre_ope1629, proposed = current. 8 dropped -> included (Marshfield Fair''s 7 Indoor Farmers'' Markets, Saco''s Main Street Market), 0 included -> dropped, 0 wrong-way. OHTM''s 17 program and closure drops unchanged.',
  NULL,
  'Backfilled 2026-11-26 by OPE-1635: the change shipped before the change log existed, so no metrics were captured at the time. feed_item_labels did not exist until 2026-11-26 either, so a before-snapshot would have been empty.',
  1795101650,
  NULL,
  NULL,
  unixepoch()
);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES
  ('feed-item-snapshot-history', unixepoch(),
   'OPE-1635 — every feed item has a history row for its current content_hash; a read that changed an item without one is a miss', unixepoch()),
  ('feed-rule-change-followup', unixepoch(),
   'OPE-1635 — a feed_rule_changes row past after_due_at with no metrics_after for 3h means the hourly cron step is not running', unixepoch())
ON CONFLICT(probe_name) DO NOTHING;
