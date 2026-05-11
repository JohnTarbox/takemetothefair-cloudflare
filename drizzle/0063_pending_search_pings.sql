-- Pending Search Pings — outbox for deferred IndexNow requests.
--
-- Bulk ingestion workflows set `defer_search_ping: true` on each write so the
-- lifecycle hook queues a row here instead of firing IndexNow immediately. The
-- flush_pending_search_pings MCP tool (and the hourly cron) drains the table,
-- dedupes URLs, and submits one batched IndexNow call.
--
-- See packages/db-schema/src/index.ts:pendingSearchPings for the typed schema.
-- Migration added 2026-05-10 alongside PR 2 of the bulk-ingest performance work.

CREATE TABLE pending_search_pings (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,        -- 'vendor' | 'venue' | 'event' | 'promoter' | 'blog'
  entity_id TEXT NOT NULL,
  entity_slug TEXT NOT NULL,
  action TEXT NOT NULL,             -- 'create' | 'update' | 'status_change'
  queued_at INTEGER NOT NULL,
  flushed_at INTEGER,
  flushed_batch_id TEXT
);

CREATE INDEX idx_pending_pings_unflushed
  ON pending_search_pings (flushed_at, queued_at);

CREATE INDEX idx_pending_pings_batch
  ON pending_search_pings (flushed_batch_id);
