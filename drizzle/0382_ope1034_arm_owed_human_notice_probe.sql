-- OPE-1034 — arm the owed-human-notice probe (OPE-1018, seeded dormant in 0290).
-- Measured on prod 2026-10-20: 19 `operator-owed-human-notice` sends,
-- 2026-09-17 → 10-17; p90 gap 124.1h, largest 255.4h. The window (372h,
-- 3 × p90) lives in src/lib/heartbeat.ts; this only sets enabled_at.
-- Only arms a still-dormant row, so it never moves an existing arming date,
-- and is a no-op on an empty database (no row to update).
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1018: operator notice ledger row (armed OPE-1034, 372h = 3x measured p90)'
WHERE probe_name = 'owed-human-notice' AND enabled_at IS NULL;
