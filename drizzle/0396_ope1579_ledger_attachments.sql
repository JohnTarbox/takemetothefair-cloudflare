-- OPE-1579: what files an email carried, so the ledger shows what was sent.
-- JSON array of {key, filename, type, size}. NULL means no attachments.
ALTER TABLE email_send_ledger ADD COLUMN attachments_json TEXT;
