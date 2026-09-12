-- OPE-944 — record the ORIGINAL sender's authentication, separately from the forwarder's.
--
-- Every auth column on inbound_emails until now describes the hop that reached
-- us. When a contributor forwards an organizer's mail that is the CONTRIBUTOR:
-- inbound 9fc287ef stores dkim=pass header.d=gmail.com / dmarc=pass /
-- sender_auth='partial', all true and all about Carolyn's Gmail, while the
-- packet we published a 59-vendor roster from was the Town of New Gloucester's.
--
-- Pure ADD COLUMN, all nullable, no backfill: safe on an empty database (CI
-- builds its D1 from migrations) and safe in prod. NULL means "row predates
-- capture", which is a different fact from 'not_forwarded'.
--
-- REPORT-ONLY. Nothing branches on these columns.
ALTER TABLE inbound_emails ADD COLUMN original_sender_address TEXT;
ALTER TABLE inbound_emails ADD COLUMN original_sender_auth TEXT;
ALTER TABLE inbound_emails ADD COLUMN original_sender_domain_aligned INTEGER;

-- Find forwards whose organizer could not be verified. Partial so the index
-- stays small: the overwhelming majority of rows are 'not_forwarded'.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_original_sender_auth
  ON inbound_emails (original_sender_auth)
  WHERE original_sender_auth IS NOT NULL AND original_sender_auth <> 'not_forwarded';
