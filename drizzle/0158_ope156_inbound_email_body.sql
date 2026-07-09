-- OPE-156 — persist the FULL inbound email body so /admin/inbound-emails can
-- show the whole message, not just the 500-char body_text_excerpt preview.
--
-- Storage choice: columns on inbound_emails (not R2). Mirrors the outbound
-- side (email_send_ledger.body_html / body_text, OPE-155 / drizzle/0157) and
-- keeps the admin read path private + single-row — the detail API runs in the
-- main-app Worker, which has no private R2 read path (attachments are served
-- via the public cdn.* URL, unsuitable for PII bodies). Captured body sizes
-- (text ≤ 50k chars, html capped in the handler) sit far under D1's 2 MB row
-- limit. Forward-looking only: historical rows keep NULL here (no backfill)
-- and degrade to the excerpt in the viewer.
ALTER TABLE inbound_emails ADD COLUMN body_text TEXT;
ALTER TABLE inbound_emails ADD COLUMN body_html TEXT;
