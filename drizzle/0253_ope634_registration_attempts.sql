-- OPE-634 — a durable trace of a registration that did NOT happen.
--
-- The cohort blocked by a registration outage is by construction the set of
-- people with NO `users` row, so it cannot be found by querying the thing they
-- failed to create. When OPE-150 broke Turnstile on 2026-07-08 the only reason
-- we know one specific prospect existed is that she wrote to support@ — and 51
-- days later she still had no account.
--
-- The funnel telemetry cannot answer it retroactively either: every
-- register_view / register_submitted series in `analytics_events` begins
-- 2026-08-16, five weeks after that outage.
--
-- Failures only. A successful registration already leaves a `users` row, so the
-- blocked cohort is the attempts whose email still has no user — which makes
-- the set self-healing when someone retries.
--
-- No foreign keys and no dependency on existing rows, so this applies cleanly
-- to a fresh CI-built D1.
CREATE TABLE IF NOT EXISTS registration_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  recovered_at INTEGER,
  recovery_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_registration_attempts_at ON registration_attempts (attempted_at);
CREATE INDEX IF NOT EXISTS idx_registration_attempts_email ON registration_attempts (email);
