-- Event slug change history — for 301-redirecting old URLs after an event
-- slug changes (typically when an admin renames an event, or the discovery
-- task normalizes an ordinal-prefix slug like
-- "55th-annual-newport-international-boat-show" → "newport-international-boat-show-2026").
--
-- Mirrors drizzle/0038_vendor_slug_history.sql exactly. The /events/[slug]
-- middleware consults this table on slug-not-found and 301-redirects to the
-- current slug. Chains are followed up to a max depth (5 hops) to handle
-- multiple consecutive renames.

CREATE TABLE event_slug_history (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  -- Optional admin user id (or null for cron / system writes).
  changed_by TEXT
);

CREATE INDEX idx_event_slug_history_old_slug ON event_slug_history(old_slug);
CREATE INDEX idx_event_slug_history_event_id ON event_slug_history(event_id);
