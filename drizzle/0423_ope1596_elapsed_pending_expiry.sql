-- OPE-1596 — heartbeat probe for the nightly elapsed-PENDING expiry (MCP 06:00Z
-- cron). Touches heartbeat_probes only (no FK), so it is a no-op-safe insert on
-- an empty database. Live from the ship date: the rule stamps
-- `watchdog:elapsed-pending-expiry` on every run, whatever it expires.
-- No schema change: expiries reuse admin_actions (event.expire_elapsed, the
-- same action the /admin/submissions bulk button writes).
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'elapsed-pending-expiry',
  1794873600,
  'OPE-1596 — watchdog:elapsed-pending-expiry stamped within 48h (nightly elapsed-PENDING expiry)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
