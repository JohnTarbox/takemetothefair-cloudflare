-- Newsletter double opt-in — adds the per-row confirmation token + expiry
-- columns to newsletter_subscribers. The raw token only ever exists in the
-- confirmation email URL; we store its SHA-256 hex digest so a DB compromise
-- can't be used to silently confirm subscriptions. Pattern mirrors
-- vendor_claim_tokens (src/lib/vendor-claim-token.ts).
--
-- The `confirmed` column already exists from a prior migration with
-- default=false. Existing rows (currently 2, both unconfirmed and
-- bot-looking) stay as-is per the 2026-05-24 decision — they'll be
-- excluded from any future send that filters confirmed=true.

ALTER TABLE newsletter_subscribers ADD COLUMN confirmation_token_hash TEXT;
ALTER TABLE newsletter_subscribers ADD COLUMN confirmation_expires INTEGER;

-- Lookup index for the confirm endpoint. Token hashes are unique-ish in
-- practice (32-byte random source → SHA-256), so a plain index is fine.
CREATE INDEX idx_newsletter_confirmation_token_hash
  ON newsletter_subscribers(confirmation_token_hash);
