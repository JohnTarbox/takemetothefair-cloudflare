-- IndexNow submissions log.
-- Records every pingIndexNow() attempt for observability — surfaces in
-- /admin/analytics → IndexNow tab. See src/lib/indexnow.ts.

CREATE TABLE IF NOT EXISTS indexnow_submissions (
  id TEXT PRIMARY KEY,
  -- Unix epoch seconds, matches errorLogs/analyticsEvents convention.
  timestamp INTEGER NOT NULL,
  -- Short identifier for the call site (e.g. 'admin-event-patch', 'blog-publish',
  -- 'backfill', 'internal-api'). Lets us spot publish paths that never ping.
  source TEXT NOT NULL,
  -- JSON-encoded array of submitted URLs.
  urls TEXT NOT NULL DEFAULT '[]',
  url_count INTEGER NOT NULL DEFAULT 0,
  -- 'success' | 'failure' | 'no_key' | 'no_eligible_urls'.
  status TEXT NOT NULL,
  -- HTTP response code from api.indexnow.org; NULL when no fetch was made
  -- (no_key, no_eligible_urls) or when a network error precluded a response.
  http_status INTEGER,
  -- Truncated response body or error message on failure; NULL on success.
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_indexnow_submissions_timestamp
  ON indexnow_submissions(timestamp DESC);
