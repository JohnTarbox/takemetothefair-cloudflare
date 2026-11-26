-- OPE-1636 part B — recurring feed discovery (feed analytics 5/5).
--
-- Once a month the MCP hourly cron probes promoters that have a website and no
-- registered feed for a usable feed: The Events Calendar REST / iCal, iCal links
-- and published Google Calendar embeds, and schema.org Event JSON-LD on the home
-- and events pages. It reads ONLY domains already on the promoter's domain list
-- (OPE-1614 matchableDomainsFor), sends the feed reader's User-Agent with a
-- timeout, skips a site that answers 403, and writes nothing to events.
--
--   feed_discovery_runs   one row per month (YYYY-MM). completed_at is set when
--                         no eligible promoter is left unprobed that month. The
--                         Worker has no Linear token (OPE-76's rail), so an agent
--                         files the analyst task via list_feed_discovery_runs and
--                         stamps ope_id with record_feed_discovery_filing.
--   feed_discovery_probes one row per (promoter, month): the outcome
--                         (found / none / blocked / error / no_domain) and the
--                         candidates found, each with an item count and sample
--                         titles. Registration stays a human decision
--                         (register_promoter_feed, questions_hold on).
--
-- Purely additive. Rollback: DROP TABLE feed_discovery_probes; DROP TABLE
-- feed_discovery_runs; DELETE FROM heartbeat_probes WHERE probe_name LIKE 'feed-discovery-%'.
CREATE TABLE IF NOT EXISTS feed_discovery_runs (
  month TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  eligible INTEGER NOT NULL DEFAULT 0,
  probed INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  ope_id TEXT,
  filed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_discovery_probes (
  id TEXT PRIMARY KEY NOT NULL,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  probed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  domains TEXT NOT NULL DEFAULT '[]',
  candidates TEXT NOT NULL DEFAULT '[]',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_discovery_probes_month
  ON feed_discovery_probes (promoter_id, month);
CREATE INDEX IF NOT EXISTS idx_feed_discovery_probes_month
  ON feed_discovery_probes (month, outcome);

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES
  ('feed-discovery-probing', unixepoch(),
   'OPE-1636 — while this month''s feed discovery run is open, the hourly cron probes a slice each fire; 6h with no new probe (or no run by the 2nd) means it is not running', unixepoch()),
  ('feed-discovery-filed', unixepoch(),
   'OPE-1636 — a completed feed discovery run with candidates must be filed as an analyst task within 72h (list_feed_discovery_runs → record_feed_discovery_filing)', unixepoch())
ON CONFLICT(probe_name) DO NOTHING;
