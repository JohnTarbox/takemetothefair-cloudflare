-- OPE-1480 — OPE-246 probe for the new writer: venue creation now fills
-- venues.accessibility / venues.parking from Google (fillVenueGoogleAmenities,
-- called by geocodeNewVenue). ARMED at ship: the evidence is demand-conditional
-- and its demand is floored at enabled_at, so venues created before this
-- migration (never filled) cannot false-fire it. No schema change; no data
-- rows touched — a no-op on an empty database apart from this seed row.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('venue-google-amenities', unixepoch(),
  'OPE-1480: new venues with a place id get Google accessibility + parking (demand-conditional)', unixepoch());
