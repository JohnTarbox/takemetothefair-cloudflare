-- OPE-1058 scope 2 — the reversal record for the one-time category rewrite.
--
-- The ticket requires the rewrite to be reversible ("log every changed row (id,
-- before, after) … so the rewrite can be reversed"), and
-- docs/bulk-mutation-discipline.md makes rollback-planned one of its four rules.
-- A log written in the same statement as the UPDATE is the only form that
-- survives a partial run: whatever was changed is recorded, and nothing else is.
--
-- No backfill, no FK: this table is empty until the rewrite runs, which is
-- correct on the fresh D1 that CI builds from migrations, and the events it
-- names may later be merged away without invalidating the record of what was
-- changed.
CREATE TABLE IF NOT EXISTS event_category_migration_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  -- JSON arrays, exactly as stored in events.categories / events.tags.
  categories_before TEXT NOT NULL,
  categories_after TEXT NOT NULL,
  tags_before TEXT,
  tags_after TEXT,
  migrated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_category_migration_log_event
  ON event_category_migration_log (event_id);
