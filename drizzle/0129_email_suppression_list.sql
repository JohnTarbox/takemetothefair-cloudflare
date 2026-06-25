-- K36 (2026-06-25) — CAN-SPAM suppression list. Keyed by LOWERCASE email.
-- An address here has unsubscribed (or was manually suppressed / bounced) and
-- must not receive solicited outbound mail: send_vendor_email, send_test_email,
-- and any K41 free-form send check this list pre-enqueue and skip a match.
-- Transactional/system emails (receipts, approval notices) are EXEMPT and do
-- not consult this list.
--
-- The one-click unsubscribe route (/unsubscribe) inserts here (reason
-- 'unsubscribe', source 'unsubscribe-link') after verifying the HMAC token.
-- IF NOT EXISTS for idempotency; deploy.yml's d1-migrate step owns application
-- (do NOT apply out-of-band). Verify:  PRAGMA table_info('email_suppression_list');
CREATE TABLE IF NOT EXISTS email_suppression_list (
  email TEXT PRIMARY KEY,
  reason TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_suppression_created_at ON email_suppression_list (created_at);
