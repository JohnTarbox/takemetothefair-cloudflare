-- OPE-1580: blank vendor forms posted to an event page by a person.
-- A row belongs to one dated event and stops serving at expires_at.
CREATE TABLE event_documents (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  year INTEGER NOT NULL,
  source_organizer TEXT NOT NULL,
  source_inbound_email_id TEXT,
  source_attachment_index INTEGER,
  source_url TEXT,
  received_at INTEGER NOT NULL,
  posted_by TEXT,
  posted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  withdrawn_reason TEXT,
  withdrawn_at INTEGER
);
CREATE INDEX idx_event_documents_event ON event_documents(event_id, status);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'event-document-post',
  NULL,
  'OPE-1580 — post_event_document writes event_document.posted; dormant until a person posts the first form',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
