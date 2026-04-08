-- Vendor decision-support fields for events
ALTER TABLE events ADD COLUMN vendor_fee_min REAL;
ALTER TABLE events ADD COLUMN vendor_fee_max REAL;
ALTER TABLE events ADD COLUMN vendor_fee_notes TEXT;
ALTER TABLE events ADD COLUMN indoor_outdoor TEXT;
ALTER TABLE events ADD COLUMN estimated_attendance INTEGER;
ALTER TABLE events ADD COLUMN event_scale TEXT;
ALTER TABLE events ADD COLUMN application_deadline INTEGER;
ALTER TABLE events ADD COLUMN application_url TEXT;
ALTER TABLE events ADD COLUMN application_instructions TEXT;
ALTER TABLE events ADD COLUMN walk_ins_allowed INTEGER;

-- Vendor geolocation (auto-populated from Google Places address lookup)
ALTER TABLE vendors ADD COLUMN latitude REAL;
ALTER TABLE vendors ADD COLUMN longitude REAL;
