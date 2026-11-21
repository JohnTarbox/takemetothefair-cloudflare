-- OPE-1615 — classifier timeouts are retried (+2 / +10 / +30 min) before any
-- lane, reply or event. The probe watches the retry loop's per-attempt step
-- record. Armed at ship: the loop's demand is the existing ~10% classifier
-- error rate (OPE-1089), and the 30-day window is sized for it.
-- An INSERT with no foreign keys, so a no-op-safe apply on an empty database.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'classifier-retry',
  unixepoch(),
  'OPE-1615 — evidence = newest workflow_run_steps row with step_name=classify-retry/attempt',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
