-- Add commercial_vendors_allowed field to events table
ALTER TABLE events ADD COLUMN commercial_vendors_allowed INTEGER DEFAULT 1;
