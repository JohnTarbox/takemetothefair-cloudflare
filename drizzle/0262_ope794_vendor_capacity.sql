-- OPE-794 — a structured signal for "is there a booth to apply for".
--
-- Two of six events approved on 2026-09-03 were not open to new vendors
-- (Ogunquit "We are full for 2026"; Manchester Grange first floor sold out) and
-- the fact survived only as prose in vendor_fee_notes. Nothing could query it,
-- and the vendor digest — subject line "Shows Now Open for Vendors" — had no way
-- to exclude a full show from an "Apply via organizer" CTA.
--
-- On event_applications rather than events, because OPE-709 made the LANE the
-- unit an applicant deals with: a fair can be full for crafters and open for
-- food trucks.
--
-- DEFAULT 'UNKNOWN', deliberately not 'OPEN'. An optimistic default would
-- assert something nobody checked for all 100+ existing rows — precisely the
-- dates_confirmed DEFAULT true failure (OPE-433). Every existing row is
-- therefore honest on arrival: we do not know.
--
-- Idempotent + safe on an EMPTY database: these are pure ALTERs with a constant
-- default and no FK-bearing inserts, so CI's fresh-D1 migration run applies them
-- with nothing seeded.
ALTER TABLE event_applications ADD COLUMN capacity_status TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE event_applications ADD COLUMN capacity_as_of INTEGER;
ALTER TABLE event_applications ADD COLUMN capacity_note TEXT;

-- The digest's selection filters on this; without an index it is a scan of every
-- application row on every send.
CREATE INDEX IF NOT EXISTS idx_event_applications_capacity
  ON event_applications (capacity_status);
