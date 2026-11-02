-- OPE-1564: who may be a VENDOR at an event, as its own axis.
-- Separate from commercial_vendors_allowed (are commercial sellers admitted at
-- all) and from primary_audience (who may ATTEND). Both are unchanged.
--   vendor_eligibility      OPEN (default: no restriction recorded / nobody has
--                           looked; renders nothing) | MEMBERS_ONLY | JURIED |
--                           INVITATION_ONLY
--   vendor_eligibility_org  optional org name, <=120 chars; used in the public
--                           line "Vendors must be members of <org>." only
-- Tracked for provenance like the vendor fees: update_event(citation=...) records
-- an event_data_citations row per field (field_name = the column name).
-- No backfill here: the existing rows take the OPEN default, which renders
-- exactly as before. The single Craftworkers row is set through update_event
-- with a citation after deploy (the ticket's own scope item 5).
ALTER TABLE events ADD COLUMN vendor_eligibility TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE events ADD COLUMN vendor_eligibility_org TEXT;
