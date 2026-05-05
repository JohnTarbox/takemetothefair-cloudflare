-- 0057: §10.2 time-to-index per-URL cycle time.
--
-- One row per (url, indexnow_submitted_at) pair. Created when an IndexNow
-- submission fires; first_crawl_at + lag_seconds populated by a sweep that
-- joins against gsc_inspection_state.lastCrawlTime where the crawl
-- post-dates the submission.
--
-- Powers the §10.3 "Time-to-index median" widget.

CREATE TABLE time_to_index_log (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  target_type TEXT,                       -- 'vendor' | 'event' | 'venue' | 'blog' | null for non-entity URLs
  target_id TEXT,
  indexnow_submitted_at INTEGER NOT NULL,
  first_crawl_at INTEGER,                 -- null until reconciled
  lag_seconds INTEGER,                    -- first_crawl_at - indexnow_submitted_at when both known
  computed_at INTEGER NOT NULL            -- when this row was last (re)computed
);

CREATE INDEX idx_time_to_index_log_url ON time_to_index_log(url);
CREATE INDEX idx_time_to_index_log_first_crawl_at ON time_to_index_log(first_crawl_at);
CREATE INDEX idx_time_to_index_log_target ON time_to_index_log(target_type, target_id);
CREATE UNIQUE INDEX uq_time_to_index_log_url_submitted ON time_to_index_log(url, indexnow_submitted_at);
