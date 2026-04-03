-- Add indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_events_status_startdate ON events(status, start_date);
CREATE INDEX IF NOT EXISTS idx_events_venueid ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_promoterid ON events(promoter_id);
CREATE INDEX IF NOT EXISTS idx_eventvendors_eventid_status ON event_vendors(event_id, status);
CREATE INDEX IF NOT EXISTS idx_eventvendors_vendorid ON event_vendors(vendor_id);
CREATE INDEX IF NOT EXISTS idx_venues_status ON venues(status);
CREATE INDEX IF NOT EXISTS idx_userfavorites_userid_type ON user_favorites(user_id, favoritable_type);
