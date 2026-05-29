-- vendor_outreach_attempts: log substrate for the
-- /admin/vendor-claim-leaderboard outreach workflow (analyst J1,
-- 2026-05-29 PM). One row per outreach attempt; outcomes update the
-- same row in place when the channel produces a result.
--
-- Modelled on enrichment_log: append-then-update shape with FK cascade
-- on vendor delete. outcome is nullable so the operator can log
-- "I sent the email; will update when she replies" and UPDATE later.
--
-- Indexes match the leaderboard query pattern: lookup-by-vendor for
-- the "Last attempt" column, and by attempt_started_at for the
-- chronological view that an operator-activity dashboard will want.

CREATE TABLE vendor_outreach_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  attempt_started_at INTEGER NOT NULL,
  channel TEXT NOT NULL,
  outcome TEXT,
  outcome_at INTEGER,
  notes TEXT,
  created_by TEXT
);

CREATE INDEX idx_vendor_outreach_attempts_vendor_id
  ON vendor_outreach_attempts (vendor_id);

CREATE INDEX idx_vendor_outreach_attempts_started
  ON vendor_outreach_attempts (attempt_started_at);
