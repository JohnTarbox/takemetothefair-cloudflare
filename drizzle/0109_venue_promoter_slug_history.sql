-- E remainder (Dev backlog 2026-06-05): venue + promoter slug history.
--
-- Closes the named-deferral from PR #338's `merge_venue` / `merge_promoter`
-- MCP tools: when those tools rename a duplicate's slug to
-- `*-merged-<id8>`, the OLD slug 404s instead of 301-redirecting to the
-- keeper -- losing inbound link equity.
--
-- Two new tables modeled on `event_slug_history` (drizzle/0061) and
-- `blog_slug_history` (drizzle/0087). After this migration + the
-- accompanying middleware update lands, /venues/<old> and
-- /promoters/<old> walk the history chain and 301 to the keeper.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('venue_slug_history');
--   PRAGMA table_info('promoter_slug_history');
-- -- expected on prod: empty (these tables don't exist yet). The IF
-- NOT EXISTS clause makes the migration idempotent regardless.

CREATE TABLE IF NOT EXISTS venue_slug_history (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_venue_slug_history_old_slug
  ON venue_slug_history (old_slug);

CREATE INDEX IF NOT EXISTS idx_venue_slug_history_venue_id
  ON venue_slug_history (venue_id);

CREATE TABLE IF NOT EXISTS promoter_slug_history (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_promoter_slug_history_old_slug
  ON promoter_slug_history (old_slug);

CREATE INDEX IF NOT EXISTS idx_promoter_slug_history_promoter_id
  ON promoter_slug_history (promoter_id);
