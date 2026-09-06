-- OPE-830 — correct the entity-write-log probe window: 72h → 336h.
--
-- drizzle/0269 seeded this probe with a 72h window chosen by ANALOGY with the
-- citation probe rather than by measurement. Measured afterwards against the
-- actual signal — `enrichment_log` rows where `source='vendor_self'`, i.e. the
-- same vendor self-edits `entity_write_log` now records — over 60 days:
--
--     active days      29
--     mean gap          2.0 days
--     MAXIMUM gap      12   days
--     gaps > 72h        3
--
-- So a 72h window would have fired red three times in two months on entirely
-- ordinary quiet. A probe that cries wolf gets muted, and a muted probe reads
-- as coverage while covering nothing.
--
-- This is the same correction OPE-541 made in drizzle/0231 for
-- `venue-decision-writer`, for the same reason and to the same number;
-- `event-series-write-path` already uses 336h.
--
-- The window itself lives in code (`expectedWindowHours` in src/lib/heartbeat.ts).
-- This migration only realigns the operator-visible note, so the probe list does
-- not describe a threshold the code no longer uses.
--
-- Idempotent UPDATE against the row 0269 created; a no-op on the empty D1 that
-- CI builds from migrations, since the WHERE matches nothing there.

UPDATE heartbeat_probes
   SET note = 'OPE-830 - watches entity_write_log for rows of ANY outcome (applied/noop/rejected), written by the vendor profile PATCH at src/app/api/vendor/profile/route.ts. Deliberately not scoped to applied: that would go red on a quiet week rather than a broken writer, and would miss the regression most worth catching - the rejection path being dropped in an auth-gate refactor, which compiles clean and breaks no test. Window 336h, measured: over 60 days vendor_self saves had a mean gap of 2.0 days and a MAXIMUM gap of 12 days, with 3 gaps over 72h, so the original 72h would have fired on ordinary quiet.',
       updated_at = unixepoch()
 WHERE probe_name = 'entity-write-log-writer';
