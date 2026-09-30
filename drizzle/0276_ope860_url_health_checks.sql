-- OPE-860 — record when we last LOOKED at an outbound organizer URL, and what
-- we saw.
--
-- Before this, a URL checked yesterday and found healthy was indistinguishable
-- from one last looked at in 2024: the drift sweep persists a row only when it
-- records drift, so a clean check left no trace. Two dead-and-repurposed
-- domains were found in one 7-day window (OPE-857), both returning HTTP 200,
-- both invisible to every status-code-based check we had.
--
-- Append-only: one row per look. "no_event_signal every day for three weeks"
-- and "blipped once" need different responses, and an in-place update destroys
-- the only thing that distinguishes them.
--
-- Creates a new table only — no backfill, no FK to an existing row — so this is
-- a no-op on an empty database and cannot abort a fresh CI migration run.
CREATE TABLE IF NOT EXISTS url_health_checks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  source_field  TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  http_status   INTEGER,
  signals       TEXT,
  detail        TEXT,
  checked_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_url_health_checks_url        ON url_health_checks(url);
CREATE INDEX IF NOT EXISTS idx_url_health_checks_checked_at ON url_health_checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_url_health_checks_verdict    ON url_health_checks(verdict);
