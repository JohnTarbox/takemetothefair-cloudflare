-- Add source tracking fields for synced events
ALTER TABLE events ADD COLUMN source_name TEXT;
ALTER TABLE events ADD COLUMN source_url TEXT;
ALTER TABLE events ADD COLUMN source_id TEXT;
ALTER TABLE events ADD COLUMN sync_enabled INTEGER DEFAULT 1;
ALTER TABLE events ADD COLUMN last_synced_at INTEGER;
