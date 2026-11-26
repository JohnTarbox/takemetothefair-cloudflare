-- OPE-1621 — change pings: an organizer's site says "this page or feed
-- changed", and we re-read it soon instead of waiting for the next poll.
-- A ping only TRIGGERS a read; it never carries data.
--
-- promoter_event_feeds gains the ping state: the oldest outstanding ping
-- (cleared by the read that serves it), the newest one, and a lifetime count.
-- A ping moves next_read_at EARLIER (min(existing, now + 2 min)); the feed-poll
-- cron reads it, gated by FEED_POLLING_ENABLED like every scheduled read.
--
-- feed_websub_subscriptions: a WebSub hub subscription per feed, made when a
-- read sees rel="hub". A verified notification is treated as a ping.
--
-- feed_ping_counts: per-day counters of what pings did, ignored ones
-- included. The URL is never stored.
--
-- No data is written: every new column is NULL or a default, both tables start
-- empty, and the one INSERT is the heartbeat probe seed (heartbeat_probes has
-- no FK), so this applies cleanly to an empty db.

ALTER TABLE promoter_event_feeds ADD COLUMN ping_requested_at INTEGER;
ALTER TABLE promoter_event_feeds ADD COLUMN last_pinged_at INTEGER;
ALTER TABLE promoter_event_feeds ADD COLUMN ping_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_promoter_event_feeds_ping ON promoter_event_feeds (ping_requested_at);

CREATE TABLE feed_websub_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  feed_id TEXT NOT NULL REFERENCES promoter_event_feeds(id) ON DELETE CASCADE,
  hub_url TEXT NOT NULL,
  topic_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',     -- pending | active | denied
  pending_mode TEXT,                         -- 'subscribe' while a request awaits the hub's intent check
  lease_seconds INTEGER,
  lease_expires_at INTEGER,
  requested_at INTEGER,
  verified_at INTEGER,
  last_notified_at INTEGER,
  notify_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_feed_websub_feed_hub_topic ON feed_websub_subscriptions (feed_id, hub_url, topic_url);
CREATE INDEX idx_feed_websub_lease ON feed_websub_subscriptions (state, lease_expires_at);

CREATE TABLE feed_ping_counts (
  day TEXT NOT NULL,                         -- UTC YYYY-MM-DD
  channel TEXT NOT NULL,                     -- ping | websub
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, channel, outcome)
);

-- OPE-246 — the */10 pinged-feed pass. DORMANT (enabled_at NULL): with
-- FEED_POLLING_ENABLED "false" a ping is recorded but never read, so an
-- outstanding ping would look like a dead pass. Set enabled_at the day the
-- flag flips.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'feed-change-ping',
  NULL,
  'OPE-1621 — a pinged feed (change ping or WebSub notification) is re-read within the hour; dormant until FEED_POLLING_ENABLED',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
