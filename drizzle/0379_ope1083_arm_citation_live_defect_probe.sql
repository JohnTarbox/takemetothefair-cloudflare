-- OPE-1083 — arm the `citation-live-defect` heartbeat probe (seeded dormant
-- by drizzle/0295). Measured on prod 2026-10-19: 26 organic `citation_flag`
-- discrepancies since 09-19, in batches across 10 pass days; the longest gap
-- between passes is 166h. Window 336h is set in heartbeat.ts.
-- No-op on an empty DB: an UPDATE of a seeded row.
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1083: armed 2026-10-19; window 336h = ~2x the longest measured gap between passes (166h, n=26 rows / 10 pass days)'
WHERE probe_name = 'citation-live-defect';
