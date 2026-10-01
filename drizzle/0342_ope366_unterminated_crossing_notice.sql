-- OPE-366 — E2 conditional push for unterminated membrane crossings.
--
-- The detector (mcp-server/src/inbound/unterminated-crossings.ts, PR #852) and
-- its Monday-inventory line already exist. This adds the half that PUSHES: the
-- hourly MCP cron emails when a crossing that is NEWER than the last notice has
-- aged past the threshold with no destination. A standing backlog never re-alarms;
-- only a new dead-end does. The first run (no row here) reports the backlog once.
--
--   id                       → constant PK ("unterminated_crossing_notice"); single row.
--   high_water_created_at    → created_at (unix seconds) of the newest crossing
--                              already reported. A crossing newer than this fires.
--   last_count               → unterminated count at the last notice (audit).
--   last_notified_at         → unix seconds of the last notice (audit).
--
-- No writes to existing tables: an absent row reads as "never notified".
CREATE TABLE IF NOT EXISTS unterminated_crossing_notice_state (
  id                     TEXT PRIMARY KEY,
  high_water_created_at  INTEGER NOT NULL,
  last_count             INTEGER NOT NULL,
  last_notified_at       INTEGER NOT NULL
);

-- OPE-246 — heartbeat probe for the new hourly execution path. Evidence is the
-- run stamp (agent_heartbeats 'watchdog:unterminated-crossing-notice'), written
-- on every completed run whether or not it notified. Armed on ship. No FK, so
-- this is a plain insert on an empty CI database.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'unterminated-crossing-notice',
  unixepoch(),
  'OPE-366 — hourly MCP cron: E2 push for membrane crossings with no destination',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
