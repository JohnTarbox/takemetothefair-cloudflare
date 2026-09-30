-- OPE-988 — seed the source-agreement / domain-takeover sweep probe, ARMED.
--
-- CLAUDE.md (OPE-246) requires a probe in the same PR as a new execution path.
-- This is one: a sweep driven from the daily event-date-drift workflow that
-- writes url_health_checks rows with source_field
-- 'events.source_url@source-agreement'.
--
-- ARMED rather than dormant. None of the three reasons to ship dormant apply:
--   * no flag gates it — the workflow loop ships enabled in this same PR;
--   * the window is derived from the schedule — the driver is on `0 6 * * *`,
--     so 72h is three missed runs;
--   * the population is measured — 516 distinct source URLs on events starting
--     within [-30d, +120d] in prod on 2026-09-13.
--
-- ⚠️ Scoped to that source_field on purpose: the drift sweep writes the same
-- table under 'events.source_url' and the promoter sweep under
-- 'promoters.website'; an unscoped probe would be held green by either.
--
-- No-op on an empty database: bare INSERT, no foreign keys.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'source-agreement-sweep',
  unixepoch(),
  'OPE-988 - watches url_health_checks for source_field=events.source_url@source-agreement, written by the source-agreement and domain-takeover sweep that the daily event-date-drift workflow drives. Scoped to that source_field: the drift and promoter sweeps write the same table under other fields. Window 72h = three missed runs of a 0 6 * * * cron.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
