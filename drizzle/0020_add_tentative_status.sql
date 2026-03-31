-- Add submitted_by_user_id column to events table
-- Tracks who submitted the event regardless of role (vendor, community user, etc.)
ALTER TABLE events ADD COLUMN submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
