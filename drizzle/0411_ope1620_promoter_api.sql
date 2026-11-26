-- OPE-1620 — a public, signed event-submission API for promoters.
--
-- A claimed promoter mints API keys in the portal and posts events to
-- /api/v1/promoter/events from its own system (or Zapier / Make). Every request
-- is HMAC-SHA256 signed with the key's secret; the write path is the OPE-1618
-- spreadsheet import's (a new event goes in PENDING and cited, a change to a
-- live listing is staged for review, never written).
--
-- promoter_api_keys       — key_id is public (prefixed mmk_), secret is the
--                           HMAC key (hex, 32 random bytes). The secret is
--                           stored in D1 like syndication_subscribers.signing_secret:
--                           the server must hold it to verify a signature.
-- promoter_api_requests   — (key_id, request_id) seen, for replay rejection.
--                           Pruned to the last day on write.
-- promoter_api_event_refs — the promoter's own id for an event. UNIQUE(promoter,
--                           external_id) makes the upsert idempotent. event_id
--                           is NULL only while the create that claimed the ref
--                           is in flight.
--
-- No data is written apart from the dormant heartbeat probe seed (no FK).

CREATE TABLE promoter_api_keys (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX uq_promoter_api_keys_key_id ON promoter_api_keys (key_id);
CREATE INDEX idx_promoter_api_keys_promoter ON promoter_api_keys (promoter_id);

CREATE TABLE promoter_api_requests (
  key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_promoter_api_requests_key_request ON promoter_api_requests (key_id, request_id);
CREATE INDEX idx_promoter_api_requests_created ON promoter_api_requests (created_at);

CREATE TABLE promoter_api_event_refs (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  key_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_promoter_api_event_refs_external ON promoter_api_event_refs (promoter_id, external_id);
CREATE INDEX idx_promoter_api_event_refs_event ON promoter_api_event_refs (event_id);
CREATE INDEX idx_promoter_api_event_refs_updated ON promoter_api_event_refs (updated_at);

-- OPE-246 — a new writer path. DORMANT (enabled_at NULL) until promoters use
-- the API; arm it with a measured window then, so it never false-fires.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-api-write',
  NULL,
  'OPE-1620 — /api/v1/promoter/events touches promoter_api_event_refs.updated_at; dormant until promoters use the API',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
