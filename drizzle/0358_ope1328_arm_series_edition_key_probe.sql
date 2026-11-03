-- OPE-1328 — arm the `series-edition-key` heartbeat probe (seeded dormant by
-- drizzle/0356). NEAR-Fest was flipped to multi-edition on 2026-10-06 (John's
-- approval in session: "flip NEAR-Fest"), so the edition-key writer now has a
-- live series. No-op on an empty DB: an UPDATE of a seeded row.
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1328: armed 2026-10-06 after the NEAR-Fest flip; window 270d is a judgement (n=1), see heartbeat.ts'
WHERE probe_name = 'series-edition-key';
