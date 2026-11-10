-- OPE-1617 — universal calendar reader: plain iCal feeds, shared Google /
-- Outlook calendar addresses, and schema.org Event JSON-LD, through OPE-1613's
-- provenance pipeline.
--
-- `promoter_event_feeds.kind` gains 'jsonld' (TS enum; the column has no CHECK).
-- 'ical' already existed in 0406 as a refused value and is now read.
--
-- Polite polling state per feed: the validators from the last good read (a
-- conditional GET sends them back, so an unchanged feed is a 304 and no work),
-- the per-feed interval (default 6h), the error streak that drives backoff, and
-- the next due time the scheduler reads.
--
-- Ownership proof is RECORDED, not re-derived: which rule admitted the feed
-- (its host on the org's domain list, OPE-1614 — or, for a Google / Outlook
-- calendar address, a validated contact who sent it), with the inbound id when
-- that is the proof.
--
-- `promoter_feed_items.missing_since` marks a previously-seen item that a later
-- read no longer carries — the "dropped VEVENT" cancellation signal.
--
-- No feed data is written: every new column is NULL or a default on existing
-- rows, and no feed is registered. The one INSERT is the heartbeat probe seed
-- (heartbeat_probes has no FK), so this applies cleanly to an empty db.

ALTER TABLE promoter_event_feeds ADD COLUMN poll_interval_hours INTEGER NOT NULL DEFAULT 6;
ALTER TABLE promoter_event_feeds ADD COLUMN next_read_at INTEGER;
ALTER TABLE promoter_event_feeds ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promoter_event_feeds ADD COLUMN http_etag TEXT;
ALTER TABLE promoter_event_feeds ADD COLUMN http_last_modified TEXT;
ALTER TABLE promoter_event_feeds ADD COLUMN ownership_basis TEXT;          -- domain_list | validated_contact
ALTER TABLE promoter_event_feeds ADD COLUMN ownership_evidence TEXT;
ALTER TABLE promoter_event_feeds ADD COLUMN ownership_inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL;
CREATE INDEX idx_promoter_event_feeds_due ON promoter_event_feeds (enabled, next_read_at);

ALTER TABLE promoter_feed_items ADD COLUMN missing_since INTEGER;

-- OPE-246 — the hourly poll job writes one info row per run (flag on or off),
-- so its probe is live from the ship date. The reads themselves stay covered by
-- the dormant 'organizer-feed-ingest' probe (0406) until a feed is polled.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'organizer-feed-poll',
  unixepoch(),
  'OPE-1617 — hourly organizer-feed poll writes one info row per run (feeds:scheduled-poll)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
