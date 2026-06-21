-- REL7 (2026-06-21) — per-URL last-successful-IndexNow-ping ledger.
--
-- Root cause it fixes: both REL4 un-pause attempts (6/15, 6/19) re-tripped Bing's
-- per-host throttle because the deferred queue re-pinged the SAME URLs identically
-- on every flush. The suppressor in pingIndexNow() reads this table BEFORE the
-- circuit breaker: a URL that returned 2xx from Bing within the last 24h is dropped
-- (recorded as status='suppressed_dedup' in indexnow_submissions) instead of
-- re-submitted, so the penalty can decay.
--
--   url            canonical public URL (PK); one row per URL, upserted on success.
--   last_success_at seconds-epoch of the most recent 2xx Bing submission.
--   content_hash    RESERVED for v2 (the "content changed → bypass suppression"
--                   path). Unused/NULL in v1 — pure 24h suppression.
--   updated_at      seconds-epoch of the last write to this row.
--
-- IF NOT EXISTS so a re-run / out-of-band create can't wedge `migrations apply`
-- (see the drizzle/0123 incident).
-- Verify not already present:  PRAGMA table_info('indexnow_url_last_success');
CREATE TABLE IF NOT EXISTS indexnow_url_last_success (
  url TEXT PRIMARY KEY,
  last_success_at INTEGER NOT NULL,
  content_hash TEXT,
  updated_at INTEGER NOT NULL
);
