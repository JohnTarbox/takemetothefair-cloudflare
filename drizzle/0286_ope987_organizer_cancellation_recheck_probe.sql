-- OPE-987 — heartbeat probe for the organizer-page cancellation recheck
-- (mcp-server/src/goodwill/cancellation-recheck.ts, run as steps of the daily
-- 06:00Z EventDateDriftWorkflow). Armed on ship: the pass runs from the deploy
-- that carries this migration, and the probe watches its run stamp
-- (agent_heartbeats 'watchdog:organizer-cancellation-recheck'), which is
-- written on every completed call whether or not any url was due.
--
-- Seed row only — no FK, no data move — so it is a no-op on an empty database.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'organizer-cancellation-recheck',
  unixepoch(),
  'OPE-987 — organizer-page cancellation notice recheck, daily drift-workflow run stamp (raises status discrepancies, never cancels)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
