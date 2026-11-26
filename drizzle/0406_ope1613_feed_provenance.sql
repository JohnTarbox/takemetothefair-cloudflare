-- OPE-1613 — organizer feed ingestion with field-level provenance (John ruling 2026-11-10).
--
-- Field provenance builds ON event_data_citations rather than beside it: the
-- active citation for (event, field) already IS "where the current value came
-- from". What it lacked is a classifier that says which RUNG of the authority
-- ladder the value sits on (validated contact > feed / organizer website >
-- extraction; operator keeps its standing). `source_type` cannot carry that —
-- an organizer's feed and an organizer's homepage are both `official_website`,
-- and a contact's reply and an anonymous form are both `user_submitted`. So one
-- nullable column. NULL = a row written before this migration; readers report
-- it as `unclassified` and NEVER infer a rung from `source_type` (a derived
-- authority would agree with the stored one until the day it didn't).
--
-- Pins are their own table because a pin is STATE, not a citation: it holds
-- the feed value that was wrong when the contact answered, which is what lets
-- the next read tell "feed still wrong" from "feed fixed" from "a third value".
--
-- Every table here starts EMPTY and nothing reads a feed on a schedule: feeds
-- are registered and read only by an operator through MCP (dry-run default).
-- No row is seeded, so this migration is a no-op on an empty DB apart from DDL.

ALTER TABLE event_data_citations ADD COLUMN provenance_kind TEXT;
-- feed | organizer_website | validated_contact | operator | extraction (no CHECK, TS enum)

CREATE TABLE promoter_event_feeds (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  feed_url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tec_rest',              -- tec_rest | ical
  inclusion_rules TEXT,                                -- JSON; NULL = defaults
  -- The feed-discrepancy question limit, separate from the pre-season
  -- outreach cap (John 2026-11-10). Default: one batch per contact per 7 days.
  batch_min_interval_days INTEGER NOT NULL DEFAULT 7,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_read_at INTEGER,
  last_read_status TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_promoter_event_feeds_url ON promoter_event_feeds (promoter_id, feed_url);

-- One row per feed item ever seen. event_id NULL = not linked to an MMATF
-- event (a new event awaiting review, or one the inclusion filter dropped).
CREATE TABLE promoter_feed_items (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES promoter_event_feeds(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  title TEXT,
  url TEXT,
  start_local TEXT,
  included INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  review_state TEXT NOT NULL DEFAULT 'none',           -- none | awaiting_review | linked | dropped
  content_hash TEXT,
  snapshot TEXT,                                       -- JSON of the mapped item, last read
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_promoter_feed_items_ext ON promoter_feed_items (feed_id, external_id);
CREATE INDEX idx_promoter_feed_items_event ON promoter_feed_items (event_id);

CREATE TABLE event_field_pins (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  pinned_value TEXT NOT NULL,
  -- The feed's value when the contact answered; "same wrong value" is judged against it.
  feed_value_at_pin TEXT,
  contact_id TEXT REFERENCES promoter_contacts(id) ON DELETE SET NULL,
  inbound_email_id TEXT,
  citation_id TEXT REFERENCES event_data_citations(id) ON DELETE SET NULL,
  discrepancy_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',               -- active | released
  -- How many times a batch has repeated "your feed still says X" (cap 1).
  still_wrong_notes_sent INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  release_reason TEXT,                                 -- feed_fixed | operator | superseded
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- At most one live pin per (event, field).
CREATE UNIQUE INDEX uq_event_field_pins_live ON event_field_pins (event_id, field_name)
  WHERE status = 'active';

-- One row per batched question email composed (as an operator draft).
CREATE TABLE feed_discrepancy_batches (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES promoter_contacts(id) ON DELETE CASCADE,
  draft_id TEXT,                                       -- operator_outbound_drafts.id
  discrepancy_ids TEXT NOT NULL,                       -- JSON array
  still_wrong_pin_ids TEXT NOT NULL DEFAULT '[]',      -- JSON array
  composed_at INTEGER NOT NULL
);
CREATE INDEX idx_feed_discrepancy_batches_contact ON feed_discrepancy_batches (contact_id, composed_at);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'organizer-feed-ingest',
  NULL,
  'OPE-1613 — ingest_promoter_feed writes feed.ingested; dormant until a feed is registered and read on a schedule',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
