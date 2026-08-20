-- OPE-472 rework — seed the `series-write-path` heartbeat probe.
--
-- Enabled immediately, not dormant: the write path shipped in PR #931 and prod
-- already mints series rows (4 on 2026-08-20 alone, the newest at the same
-- second as the newest event), so the probe has evidence from the moment it
-- ships and cannot false-RED.
--
-- What it watches, and why THIS signal. The defect this probe exists for is
-- silence, not a crash: `event_series` was backfilled once and went inert for
-- seven weeks while every new event was born unparented, with the newest-series
-- date frozen at 2026-06-30 and nobody looking.
--
-- Evidence is a series row being CREATED. Deliberately NOT the orphan count:
-- the resolver skips venue-less events by design (keying on name alone would
-- put every "Holiday Craft Fair" in New England under one parent), so the
-- orphan total legitimately climbs while the writer is perfectly healthy.
-- Reading that climb as failure is exactly what produced a REVIEW FAIL against
-- a live fix on 2026-08-20; a probe on the CREATE answers the question directly
-- instead of leaving it to inference.
--
-- 14-day window because series creation is demand-driven — a parent is minted
-- only for the FIRST edition of a fair at a venue, so a quiet fortnight of
-- familiar events is normal and a shorter window would cry wolf.
--
-- Pure insert into a probe-registry table with no FK to event data, so it is a
-- clean no-op against the empty D1 that CI builds from migrations.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'series-write-path',
  unixepoch(),
  'OPE-472 — series parent minted at event write time; watches max(event_series.created_at). Probes the CREATE, never the orphan count (which climbs legitimately on venue-less events the resolver skips by design).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
