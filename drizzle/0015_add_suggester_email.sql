-- Add suggester_email column to events table for community-suggested events
ALTER TABLE events ADD COLUMN suggester_email TEXT;
