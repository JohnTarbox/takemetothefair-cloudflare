-- OPE-1634 — feed analytics 3/5: quality checks on our own rules.
--
-- 1. promoter_feed_items gains three columns:
--      inclusion_reason   — the verdict's reason for EVERY item (exclusion_reason
--                           is NULL when included, so per-rule precision had no rule)
--      link_basis         — how a link was made: source_url / promoter_date_name
--                           (automatic) or review_link / review_approve (a reviewer)
--      unlinked_event_id  — the event a reviewer UNLINKED the item from; the ingest
--                           never auto-links the item to it again
-- 2. feed_item_labels  — reviewer / analyst decisions as ground-truth labels.
-- 3. feed_drop_samples — the weekly dropped-item sample for the analyst (one row
--                        per week, even when empty), filed by an agent session.
-- 4. organizer_feed becomes a reliability source type: priors copied from
--    `official` (an organizer's own calendar is first-party), one `sources` row
--    per feed, and the open/closed organizer_feed discrepancies get the feed's
--    key so a resolution scores it. Before this, all 57 rows carried
--    divergent_source_key NULL and updateReliability skipped every one.
-- 5. Three heartbeat probes (OPE-246), armed 2026-11-27T00:00:00Z (1795737600).
--
-- Every backfill keys on existing rows, so on an empty database this migration
-- only creates tables and seeds the probe + prior rows.

ALTER TABLE promoter_feed_items ADD COLUMN inclusion_reason TEXT;
ALTER TABLE promoter_feed_items ADD COLUMN link_basis TEXT;
ALTER TABLE promoter_feed_items ADD COLUMN unlinked_event_id TEXT;

CREATE TABLE IF NOT EXISTS feed_item_labels (
  id TEXT PRIMARY KEY,
  feed_item_id TEXT NOT NULL REFERENCES promoter_feed_items(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL,
  label TEXT NOT NULL,
  rule_key TEXT,
  reason TEXT,
  included INTEGER,
  link_basis TEXT,
  event_id TEXT,
  source TEXT NOT NULL,
  actor TEXT,
  note TEXT,
  sample_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_item_labels_item ON feed_item_labels (feed_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feed_item_labels_created ON feed_item_labels (created_at);

CREATE TABLE IF NOT EXISTS feed_drop_samples (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  items TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  dropped_total INTEGER NOT NULL,
  ope_id TEXT,
  filed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_drop_samples_week ON feed_drop_samples (week_start);

-- Backfill: a dropped item's reason is its exclusion reason. Included items get
-- theirs on the next read (every read rewrites every item it carries).
UPDATE promoter_feed_items SET inclusion_reason = exclusion_reason
  WHERE inclusion_reason IS NULL AND exclusion_reason IS NOT NULL;

-- Backfill link_basis from the STORED review action where one exists.
UPDATE promoter_feed_items SET link_basis = CASE
    (SELECT a.action FROM admin_actions a
      WHERE a.target_type = 'promoter_feed_item' AND a.target_id = promoter_feed_items.id
        AND a.action LIKE 'feed_item.%' ORDER BY a.created_at DESC LIMIT 1)
    WHEN 'feed_item.link' THEN 'review_link'
    WHEN 'feed_item.approve' THEN 'review_approve'
    WHEN 'feed_item.approve_as_occurrence' THEN 'review_approve'
    ELSE NULL END
  WHERE event_id IS NOT NULL AND link_basis IS NULL AND reviewed_at IS NOT NULL;
-- Linked with no reviewer: the ingest made it, by a basis it never stored.
UPDATE promoter_feed_items SET link_basis = 'auto_pre_ope1634'
  WHERE event_id IS NOT NULL AND link_basis IS NULL;

-- organizer_feed priors = official's (same Beta pseudo-counts per cell).
INSERT OR IGNORE INTO source_type_priors (source_type, field_class, axis, prior_alpha, prior_beta)
  SELECT 'organizer_feed', field_class, axis, prior_alpha, prior_beta
  FROM source_type_priors WHERE source_type = 'official';

INSERT OR IGNORE INTO sources (source_key, display_name, source_type, notes, created_at)
  SELECT 'organizer_feed:' || f.id,
         coalesce(p.company_name, f.promoter_id) || ' calendar feed',
         'organizer_feed', f.feed_url, unixepoch()
  FROM promoter_event_feeds f LEFT JOIN promoters p ON p.id = f.promoter_id;

-- Key the existing feed discrepancies to their feed (via the linked item).
UPDATE event_discrepancies SET divergent_source_key = (
    SELECT 'organizer_feed:' || i.feed_id FROM promoter_feed_items i
    WHERE i.event_id = event_discrepancies.event_id
    ORDER BY (i.external_id = CASE WHEN json_valid(event_discrepancies.notes)
      THEN json_extract(event_discrepancies.notes, '$.feed_item_external_id') END) DESC
    LIMIT 1)
  WHERE detected_by = 'organizer_feed' AND divergent_source_key IS NULL;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES
  ('feed-review-labels', 1795737600,
   'OPE-1634 — a feed_item.* review action with no feed_item_labels row after it is a miss', unixepoch()),
  ('feed-drop-sample-built', 1795737600,
   'OPE-1634 — the hourly cron writes one feed_drop_samples row per week, even when empty', unixepoch()),
  ('feed-drop-sample-filed', 1795737600,
   'OPE-1634 — a non-empty sample with no ope_id for 72h means no agent filed it', unixepoch())
ON CONFLICT(probe_name) DO NOTHING;
