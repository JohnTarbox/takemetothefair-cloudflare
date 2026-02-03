-- Add boolean flags to event_vendors junction table
ALTER TABLE event_vendors ADD COLUMN interested INTEGER DEFAULT 0;
ALTER TABLE event_vendors ADD COLUMN applied INTEGER DEFAULT 0;
ALTER TABLE event_vendors ADD COLUMN accepted INTEGER DEFAULT 0;
