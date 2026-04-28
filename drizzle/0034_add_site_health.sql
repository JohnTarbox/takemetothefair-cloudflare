-- Site Health unified panel — three tables.
-- See plan/i-received-this-from-federated-globe.md Phase 4 for context.

-- Persisted snapshot of issues from Bing Site Scan, Bing/GSC sitemap warnings,
-- and the rolling GSC URL Inspection sweep. Refreshed by the aggregator.
CREATE TABLE IF NOT EXISTS health_issues (
  id TEXT PRIMARY KEY,
  -- Stable hash of (source, issueType, normalizedUrl) — durable across cosmetic
  -- text changes so snoozes survive issue churn.
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,           -- 'BING_SCAN' | 'BING_SITEMAP' | 'GSC_SITEMAP' | 'GSC_URL_INSPECTION'
  issue_type TEXT NOT NULL,       -- e.g. 'BLOCKED_BY_ROBOTS', 'TITLE_TOO_LONG'
  severity TEXT NOT NULL,         -- 'ERROR' | 'WARNING' | 'NOTICE'
  url TEXT,                       -- nullable (some issues are site-wide)
  message TEXT,
  first_detected_at INTEGER NOT NULL,
  last_detected_at INTEGER NOT NULL,
  resolved_at INTEGER             -- NULL while open
);

CREATE INDEX IF NOT EXISTS idx_health_issues_source
  ON health_issues(source, last_detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_issues_open
  ON health_issues(resolved_at);

-- Snooze state, separate so it survives issue churn.
-- Keys on fingerprint, not health_issues.id, so a re-detected issue stays snoozed.
CREATE TABLE IF NOT EXISTS health_issue_snoozes (
  fingerprint TEXT PRIMARY KEY,
  snoozed_until INTEGER NOT NULL,
  snoozed_by TEXT NOT NULL,       -- userId
  snoozed_at INTEGER NOT NULL,
  note TEXT
);

-- URL inspection rotation state — tracks last GSC inspection per URL so the
-- daily sweep can prioritize stale URLs without re-inspecting recently-checked
-- ones. Required because GSC URL Inspection has a ~2000/day quota and our
-- sitemap has ~2200 URLs.
CREATE TABLE IF NOT EXISTS gsc_inspection_state (
  url TEXT PRIMARY KEY,
  last_inspected_at INTEGER NOT NULL,
  last_verdict TEXT,
  last_coverage_state TEXT,
  source TEXT NOT NULL DEFAULT 'sitemap'
);

CREATE INDEX IF NOT EXISTS idx_gsc_inspection_state_stale
  ON gsc_inspection_state(last_inspected_at);
