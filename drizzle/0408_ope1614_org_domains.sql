-- OPE-1614: an organization can have several domains. One row per
-- (entity, registrable domain), with how it was established. The entity's
-- website host is an implicit active member of its list (read-time, so it
-- never drifts from the website field); a `retired` row here withdraws it.
-- Every add and retire is audit-logged in admin_actions by the writer.
-- No data is written by this migration, so it is a no-op on an empty db.
CREATE TABLE org_domains (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence TEXT,
  source_url TEXT,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  added_by TEXT NOT NULL,
  retired_by TEXT,
  retired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_org_domains_entity_domain ON org_domains(entity_type, entity_id, domain);
CREATE INDEX idx_org_domains_domain ON org_domains(domain, status);

-- Operator-maintained umbrella domains (a town's departments on one town.gov,
-- Grange chapters on a state Grange domain). A domain here is shared whatever
-- the org lists say, and a shared domain never auto-attaches anything.
CREATE TABLE shared_org_domains (
  domain TEXT PRIMARY KEY,
  note TEXT,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The hourly pending-contact attach redirect-checks an unowned domain at most
-- once a day; this is when it last did.
ALTER TABLE pending_promoter_contacts ADD COLUMN domain_probed_at INTEGER;
