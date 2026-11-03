-- OPE-1264 — promoter newsletters, classified and attributed.
--
-- One row per inbound email recognised as a newsletter (an ESP marker plus a
-- bulk-mail marker; see mcp-server/src/inbound/newsletter.ts). Records WHOSE it
-- is and on what basis. `items_json` stays NULL until the itemizer (the next
-- increment) disposes of each dated mention against the promoter's events.
CREATE TABLE IF NOT EXISTS inbound_newsletters (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES inbound_emails(id) ON DELETE CASCADE,
  markers TEXT NOT NULL,
  promoter_id TEXT REFERENCES promoters(id) ON DELETE SET NULL,
  match_basis TEXT NOT NULL CHECK (match_basis IN
    ('subscription-address', 'sender-domain', 'contact-email', 'footer-name', 'unmatched')),
  sender_address TEXT,
  items_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_newsletters_promoter ON inbound_newsletters (promoter_id, created_at);

-- Heartbeat (OPE-246): ARMED, keyed on the `newsletter/classify` STEP RECORD,
-- which the inbound workflow writes for EVERY email it evaluates, newsletter
-- or not — so a quiet week of newsletters cannot false-fire it, and a dead step
-- cannot hide behind one. The window is set from measured inbound volume.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('newsletter-classify', unixepoch(), 'OPE-1264: newsletter/classify step record, written for every inbound email the workflow evaluates', unixepoch());
