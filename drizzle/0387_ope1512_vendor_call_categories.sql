-- OPE-1512 — which vendor categories a show still WANTS, and which are FULL.
--
-- The first thing a vendor asks before applying, and nothing on the record could
-- answer it. Stored per `event_applications` row (the commercial_vendor lane, in
-- practice) beside OPE-794's capacity_status, because a fair can want pottery
-- in its craft hall while its food court is full.
--
-- JSON arrays of free text in the same space as vendors.sells_category (OPE-1164:
-- "no controlled list yet"). NULL = no call published; an empty list is stored
-- as NULL too, so the two can't drift into separate meanings.
--
-- categories_as_of: when the organizer's call was true. Like capacity_as_of it
-- is the most perishable fact on the row, so it is never inferred and never
-- defaulted.
--
-- Safe on an EMPTY database: pure nullable ALTERs, no inserts.
ALTER TABLE event_applications ADD COLUMN categories_wanted TEXT;
ALTER TABLE event_applications ADD COLUMN categories_full TEXT;
ALTER TABLE event_applications ADD COLUMN categories_as_of INTEGER;
