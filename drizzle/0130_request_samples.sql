-- A9 (2026-06-26) — request_samples: edge request sampling to identify the
-- recurring 21st-of-month bot inflating GA4 (1,466 users on 5/21, 1,419 on 6/21,
-- same fingerprint). The zone is on the FREE plan, so Cloudflare Logpush (the
-- only CF-native raw-User-Agent capture) is unavailable — it's Enterprise-only.
-- Instead, src/middleware.ts samples a small slice of page requests at the edge
-- and writes UA + IP + ASN + path here, fire-and-forget via ctx.waitUntil so it
-- never blocks the response. Rows are pruned to ~60 days probabilistically by
-- the writer. Aggregate the spike window via GET /api/admin/request-samples.
--
-- Do NOT apply out-of-band — deploy.yml's d1-migrate step owns application
-- (wrangler records applied filenames in d1_migrations). Verify after deploy:
--   PRAGMA table_info('request_samples');
CREATE TABLE IF NOT EXISTS request_samples (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  path TEXT,
  method TEXT,
  user_agent TEXT,
  ip TEXT,
  asn INTEGER,
  as_organization TEXT,
  country TEXT,
  referer TEXT,
  ray TEXT
);
CREATE INDEX IF NOT EXISTS request_samples_timestamp_idx ON request_samples (timestamp);
CREATE INDEX IF NOT EXISTS request_samples_asn_idx ON request_samples (asn);
