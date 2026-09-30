-- OPE-1065 — heartbeat probe for citation live-defect findings
-- (event_discrepancies rows with detected_by='citation_flag').
-- DORMANT at ship (enabled_at NULL): the path is new and has no inter-arrival
-- to size a window from. Arm it once verification passes use `live_defect`.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'citation-live-defect',
  NULL,
  'OPE-1065 — verification-pass findings filed as work items; evidence = newest citation_flag discrepancy. Dormant until measured.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
