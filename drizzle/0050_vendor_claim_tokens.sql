-- Vendor self-serve claim verification tokens (PR G of §6.6 four-tier
-- model rollout). Token magic-link in email; vendor clicks to confirm
-- ownership of their listing → vendors.claimed flips true via the
-- /api/vendor/claim/confirm route.
--
-- Token storage is the SHA-256 hex digest of the raw token, never the
-- raw value, so a DB read can't impersonate a vendor. The raw token
-- only ever exists in the verification email URL parameter.
--
-- Single-use: row is DELETEd on successful confirm. Expired rows are
-- swept opportunistically on each confirm attempt for that token.

CREATE TABLE vendor_claim_tokens (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_vendor_claim_tokens_vendor ON vendor_claim_tokens(vendor_id);
CREATE INDEX idx_vendor_claim_tokens_expires ON vendor_claim_tokens(expires_at);
