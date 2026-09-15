-- OPE-1018 — heartbeat probe for the operator notice sent when a customer
-- answers a question a person asked them (inbound workflow step
-- notify/owed-human → EMAIL_JOBS, ledger source 'operator-owed-human-notice').
-- DORMANT (enabled_at NULL): thread_id exists only since 2026-09-04 and just two
-- rows have ever qualified, so there is no inter-arrival data to size a window
-- from. Arm once ≥8 qualifying replies exist.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'owed-human-notice',
  NULL,
  'OPE-1018 — operator notice for a reply to a human send; dormant until the arrival rate is measurable',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
