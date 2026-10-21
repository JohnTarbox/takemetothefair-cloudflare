-- OPE-1329 — arm the import-url-extract-success probe (OPE-1316, seeded dormant
-- in 0357). Measured on prod 2026-10-20: 33 "AI extraction ok" rows from
-- 2026-10-07 → 10-19, largest gap 24.01h (the daily holdout sampler sets the
-- cadence). The window (72h, 3 × the largest gap) lives in src/lib/heartbeat.ts;
-- this only sets enabled_at, only while it is still NULL, and is a no-op on an
-- empty database (no row to update).
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1316: newest "AI extraction ok" info row (armed OPE-1329, 72h = 3x measured max gap)'
WHERE probe_name = 'import-url-extract-success' AND enabled_at IS NULL;
