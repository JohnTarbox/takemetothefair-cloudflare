-- OPE-155 (2026-07-09) — store the rendered outbound body on the ledger so the
-- /admin/sent-emails viewer can show full content (OPE-151 deliberately stored
-- metadata only). Inline TEXT columns (email HTML is a few KB — mirrors how
-- inbound_emails keeps its body inline; a single value is 1 bound param, well
-- under the D1 100-param cap). Forward-looking: historical rows stay NULL.
ALTER TABLE email_send_ledger ADD COLUMN body_html TEXT;--> statement-breakpoint
ALTER TABLE email_send_ledger ADD COLUMN body_text TEXT;
