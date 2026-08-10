-- OPE-359 — separate the vendor newsletter archive from the public consumer one.
--
-- newsletter_issues had no audience discriminator, and /newsletter lists every
-- row with sent_at IS NOT NULL. Today that shows only the two weekend issues,
-- because the 2026-08-10 vendor issue still has sent_at = NULL. The moment
-- OPE-358 flips VENDOR_DIGEST_SEND_ENABLED, that issue — and every future Monday
-- vendor issue — would appear in the PUBLIC consumer archive, intermixed with
-- "This Weekend at the Fair".
--
-- Default 'weekend' is deliberate: every pre-existing row except the vendor ones
-- is a consumer issue, and a default that matches the majority means a writer
-- that forgets to set the column produces the SAFE outcome (an issue hidden from
-- the vendor archive) rather than leaking a vendor issue into the public one.
ALTER TABLE newsletter_issues ADD COLUMN audience TEXT NOT NULL DEFAULT 'weekend';

-- Backfill (bulk mutation — idempotent, single-writer, read-back-verified).
--
-- Matched on the slug stem the vendor composer generates. Deliberately NOT
-- matched on subject text, which is prose and can be reworded; the slug stem
-- comes from a constant in the composer.
UPDATE newsletter_issues
SET audience = 'vendor'
WHERE slug LIKE 'new-this-week-shows-just-added-%';

CREATE INDEX IF NOT EXISTS idx_newsletter_issues_audience ON newsletter_issues(audience, sent_at);
