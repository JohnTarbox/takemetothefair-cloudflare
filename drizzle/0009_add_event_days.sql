-- Multi-day events with different hours per day
CREATE TABLE IF NOT EXISTS event_days (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  notes TEXT,
  closed INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Index for efficient lookup by event
CREATE INDEX IF NOT EXISTS idx_event_days_event_id ON event_days(event_id);

-- Index for querying events on a specific date
CREATE INDEX IF NOT EXISTS idx_event_days_date ON event_days(date);
