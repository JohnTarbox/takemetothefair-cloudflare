-- OPE-1610: a DMARC-aligned sender whose org has no promoter row yet. Held here
-- until a promoter with that website domain exists. Sends nothing.
CREATE TABLE pending_promoter_contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  org_domain TEXT NOT NULL,
  name TEXT,
  matched_entity_type TEXT,
  matched_entity_id TEXT,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  validation_evidence TEXT,
  sender_auth TEXT,
  auth_domain TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attached_promoter_id TEXT REFERENCES promoters(id) ON DELETE SET NULL,
  attached_at INTEGER,
  first_validated_at INTEGER NOT NULL,
  last_heard_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_promoter_contacts_status ON pending_promoter_contacts(status);
CREATE INDEX idx_pending_promoter_contacts_domain ON pending_promoter_contacts(org_domain);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'pending-contact-attach',
  unixepoch(),
  'OPE-1610 — the hourly attach job writes one info row per run',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
