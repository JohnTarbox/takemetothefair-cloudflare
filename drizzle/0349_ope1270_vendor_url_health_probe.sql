-- OPE-1270 — seed the vendor website-health probe, ARMED.
--
-- CLAUDE.md (OPE-246): a new execution path ships with its probe. This is one —
-- the vendor url-health sweep the daily event-date-drift workflow drives,
-- writing url_health_checks rows with source_field 'vendors.website'.
--
-- ARMED, because none of the three reasons to ship dormant applies:
--   * no flag gates it — the workflow loop ships enabled in this same PR;
--   * the window is not an estimate — the driver is on `0 6 * * *`, so daily by
--     construction; 72h is three missed runs;
--   * the population is measured — 3,181 distinct live vendor websites in prod
--     on 2026-10-02, so every chunk examines (and writes) 50.
--
-- Scoped to source_field='vendors.website' in HEARTBEAT_PROBES; four other
-- writers share the table.
--
-- No-op on an empty database: bare INSERT, no foreign keys.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'vendor-url-health-sweep',
  unixepoch(),
  'OPE-1270 - watches url_health_checks for source_field=vendors.website, written by the vendor website-health sweep the daily event-date-drift workflow drives (20 chunks of 50 per run, least-recently-checked first). Window 72h = three missed runs of a 0 6 * * * cron.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
