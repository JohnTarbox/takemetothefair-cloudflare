-- OPE-1061 — a narrow, four-state pet_friendly field on events AND venues.
--   UNSET          nobody has looked (default; the research backlog)
--   YES / NO       the organizer/venue publishes it — MCP writers require a
--                  source URL + verbatim excerpt (a citation row)
--   NOT_PUBLISHED  looked, nothing published (the promoter-outreach backlog)
-- UNSET and NOT_PUBLISHED both render as absent. NO renders as "Service
-- animals only". The two columns are independent: a venue value is never an
-- event's answer.
ALTER TABLE events ADD COLUMN pet_friendly TEXT NOT NULL DEFAULT 'UNSET'
  CHECK (pet_friendly IN ('UNSET', 'YES', 'NO', 'NOT_PUBLISHED'));
ALTER TABLE venues ADD COLUMN pet_friendly TEXT NOT NULL DEFAULT 'UNSET'
  CHECK (pet_friendly IN ('UNSET', 'YES', 'NO', 'NOT_PUBLISHED'));
