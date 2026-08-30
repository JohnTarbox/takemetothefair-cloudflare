-- OPE-637 — heartbeat probe for the verification-threshold tuner.
--
-- Watches the info-level `error_logs` row the tune endpoint writes on EVERY
-- run, not `tunable_thresholds.updated_at`. The tuner only writes when the p90
-- actually moves, so a correctly-stable threshold and a dead cron leave
-- identical traces in the config table — probing the yield would go red on a
-- healthy week and green on a job that stopped running.
--
-- `enabled_at` is set NOW rather than NULL: the cron and the endpoint both ship
-- in this PR behind no flag, so the probe has evidence to find from the first
-- nightly run after deploy. A flag-gated writer would take NULL instead,
-- because a probe with no possible evidence is a guaranteed false red.
--
-- No-op on an empty database (a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys) so a fresh CI-built D1 applies it without an FK abort.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'verification-threshold-tuner',
  unixepoch(),
  'OPE-637 — watches error_logs for source=app/api/admin/thresholds/tune-verification, written once per nightly run whether or not the threshold moves. Probes that the cron RAN, never what it wrote: a stable p90 is correct behaviour and must not read as a fault.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
