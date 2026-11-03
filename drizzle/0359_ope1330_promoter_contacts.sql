-- OPE-1330 — promoter_contacts: the named people (or team mailboxes) at a
-- promoter who have actually corresponded with us, and how each was validated.
--
-- ⚠️ PERSONAL CONTACT DATA. Admin-only on every surface; never copied into
-- promoters.contact_email (which is public).
--
-- `email` is stored lowercase (CHECK), so the unique index on
-- (promoter_id, email) is unique on lower(email).
CREATE TABLE IF NOT EXISTS promoter_contacts (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  email TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  phone TEXT,
  validation_method TEXT NOT NULL CHECK (validation_method IN
    ('domain_verified', 'replied_to_our_mail', 'approved_claim', 'phone',
     'in_person', 'published_on_site', 'self_asserted')),
  validation_evidence TEXT,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL,
  sender_auth TEXT CHECK (sender_auth IS NULL OR sender_auth IN ('pass', 'partial', 'fail')),
  auth_domain TEXT,
  auth_domain_matches_promoter INTEGER CHECK (auth_domain_matches_promoter IS NULL OR auth_domain_matches_promoter IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validated', 'stale', 'rejected')),
  first_validated_at INTEGER,
  last_heard_at INTEGER,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_promoter_contacts_promoter_email ON promoter_contacts (promoter_id, email);
CREATE INDEX IF NOT EXISTS idx_promoter_contacts_email ON promoter_contacts (email);
CREATE INDEX IF NOT EXISTS idx_promoter_contacts_status ON promoter_contacts (status);

-- Heartbeat (OPE-246): the inbound workflow's promoter-contacts/capture step
-- records itself for EVERY email it evaluates (match or not), so the probe
-- proves the step runs, not that promoters happen to write. ARMED at ship.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('promoter-contact-capture', unixepoch(),
  'OPE-1330: inbound workflow promoter-contacts/capture step record, every email', unixepoch());
