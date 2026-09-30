-- OPE-868 — seed the promoter website-health probe, ARMED.
--
-- CLAUDE.md (OPE-246) requires a probe in the same PR as a new execution path.
-- This is one: a sweep driven from the daily event-date-drift workflow, writing
-- url_health_checks rows with source_field 'promoters.website'.
--
-- ARMED rather than dormant, and the distinction is deliberate. The three
-- documented reasons to ship dormant are: a flag gate, an unmeasurable window,
-- or an empty emitting population. NONE applies here:
--   * no flag gates it — the workflow step ships enabled in this same PR;
--   * the window is not an estimate — the driver is on `0 6 * * *`, so the
--     cadence is daily by construction and 72h is three missed runs;
--   * the population is measured — 612 distinct promoter websites in prod on
--     2026-09-09, covered by 13 chunks of 50.
--
-- ⚠️ The probe's evidence query is scoped to source_field='promoters.website'.
-- OPE-860 already writes this table from the drift sweep under
-- 'events.source_url', so an unscoped probe would be held green by the OTHER
-- writer while this one was dead — the identical defect OPE-865 fixed on the
-- newsletter probe earlier the same day.
--
-- No-op on an empty database: bare INSERT, no foreign keys.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-url-health-sweep',
  unixepoch(),
  'OPE-868 - watches url_health_checks for source_field=promoters.website, written by the promoter website-health sweep that the daily event-date-drift workflow drives. Scoped to that source_field on purpose: OPE-860 writes the same table under events.source_url, and an unscoped probe would be kept green by that writer. Window 72h = three missed runs of a 0 6 * * * cron.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
