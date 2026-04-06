-- Server-side analytics events table
-- Tracks important events that happen server-side (admin actions, status changes, etc.)
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_category TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  properties TEXT DEFAULT '{}',
  user_id TEXT,
  source TEXT
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_ts ON analytics_events(event_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_category_ts ON analytics_events(event_category, timestamp);
