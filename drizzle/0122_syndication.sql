-- SYN1 (Dev-Email-2026-06-12 §A, 2026-06-12) — generic push-on-change
-- syndication. Keeps consumer mirrors (e.g. Maine Cardworks) from silently
-- rotting after a correction in MMATF. Three new tables + one column.
--
-- Flow: every venue/event/event_day mutation writes a `syndication_outbox`
-- row in the SAME db.batch() as the entity UPDATE (so a correction is never
-- dropped) and bumps `events.syndication_version` for the affected event(s).
-- A queue dispatcher (MCP Worker) fans out HMAC-signed webhooks to registered
-- subscribers. The emitter holds ZERO subscriber-specific code — onboarding a
-- consumer is a row INSERT, not a deploy.
--
-- Two distinct version counters (faithful to the locked design §A2):
--   • syndication_outbox.change_version — monotonic per (entity_type,
--     entity_id); audit/ordering within one entity's stream.
--   • events.syndication_version — the per-EVENT counter consumers dedup on
--     ("highest version wins"). A venue edit must bump every affected event's
--     version, so it lives on the events row, not derivable from the outbox.

-- Per-event delivery version. Constant default → safe ALTER ADD COLUMN.
ALTER TABLE events ADD COLUMN syndication_version INTEGER NOT NULL DEFAULT 0;

-- Durable change-log. One row per mirror-affecting mutation; `snapshot` carries
-- the entity's full mirrored payload so a delivery is self-contained.
CREATE TABLE syndication_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,            -- 'venue' | 'event' | 'event_day'
  entity_id TEXT NOT NULL,
  change_version INTEGER NOT NULL,      -- monotonic per (entity_type, entity_id)
  changed_fields TEXT NOT NULL DEFAULT '[]',  -- JSON array of field names
  snapshot TEXT NOT NULL,              -- JSON object (mirrored payload)
  created_at INTEGER NOT NULL,
  processed_at INTEGER                 -- NULL until the dispatcher acks fan-out
);
CREATE INDEX idx_syndication_outbox_entity ON syndication_outbox (entity_type, entity_id);
CREATE INDEX idx_syndication_outbox_processed ON syndication_outbox (processed_at);

-- Registered consumers. Signing secret stored once per subscriber.
CREATE TABLE syndication_subscribers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,        -- per-subscriber HMAC-SHA256 secret
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Which event IDs a subscriber tracks. Per-event grain (consumers key on
-- event_id, not venue_id).
CREATE TABLE syndication_subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES syndication_subscribers(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_syndication_sub_event ON syndication_subscriptions (subscriber_id, event_id);
CREATE INDEX idx_syndication_subscriptions_event ON syndication_subscriptions (event_id);
