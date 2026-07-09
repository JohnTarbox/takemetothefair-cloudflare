-- OPE-151 (2026-07-09) — turn email_send_ledger into a real outbound-email
-- AUDIT log (it was a 3-day dedup table that only recorded successful QUEUE
-- sends). Adds outcome/error/subject/threading columns so "did we email X, and
-- did it go out?" is answerable, and so failures + the previously-unledgered
-- send paths (workflow auto-replies, main-app Resend sends) are visible.
--
-- All columns are additive + backfilled, so the existing rows survive.
ALTER TABLE email_send_ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';--> statement-breakpoint
ALTER TABLE email_send_ledger ADD COLUMN error TEXT;--> statement-breakpoint
ALTER TABLE email_send_ledger ADD COLUMN subject TEXT;--> statement-breakpoint
ALTER TABLE email_send_ledger ADD COLUMN inbound_email_id TEXT;--> statement-breakpoint
ALTER TABLE email_send_ledger ADD COLUMN provider TEXT;--> statement-breakpoint

-- Existing rows were all successful Cloudflare-Email-Sending queue sends.
UPDATE email_send_ledger SET status = 'sent', provider = 'cf-email' WHERE provider IS NULL;--> statement-breakpoint

-- Address search (admin viewer, OPE-152) + inbound↔outbound threading lookups.
CREATE INDEX IF NOT EXISTS idx_email_send_ledger_recipient ON email_send_ledger(recipient);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_send_ledger_inbound ON email_send_ledger(inbound_email_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_send_ledger_status ON email_send_ledger(status);
