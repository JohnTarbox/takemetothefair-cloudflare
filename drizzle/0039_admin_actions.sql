-- Admin audit log — records consequential admin actions (initially
-- Enhanced Profile lifecycle: activate, expire_set, auto_expire). Schema
-- is generic enough for other admin actions later.
--
-- Why now: round-3 work introduces several lifecycle transitions that
-- are useful to attribute later (who activated which vendor, when did
-- the cron auto-expire which rows). Easier to add the table once than
-- retrofit. Existing errorLogs is for errors only; analyticsEvents is
-- for client-side first-party tracking. This is the third axis.

CREATE TABLE admin_actions (
  id TEXT PRIMARY KEY,
  -- Dotted notation for grouping in queries: "enhanced_profile.activate",
  -- "enhanced_profile.expire_set", "enhanced_profile.auto_expire", etc.
  action TEXT NOT NULL,
  -- The admin who performed the action. NULL when the action was system-driven
  -- (e.g. the daily sweep cron flipping enhanced_profile=0 after grace).
  actor_user_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  -- JSON blob with action-specific context (previous values, durations, etc).
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_actions_target ON admin_actions(target_type, target_id);
CREATE INDEX idx_admin_actions_created_at ON admin_actions(created_at);
