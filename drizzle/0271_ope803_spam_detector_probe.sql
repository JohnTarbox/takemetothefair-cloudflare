-- OPE-803 — arm the spam triple-detector probe on the day the flag flips.
--
-- `SPAM_EVENT_RECOVERY_ENABLED` goes "false" → "true" in the same change
-- (mcp-server/wrangler.toml), authorized by John in session 2026-09-07 after a
-- dry-run of the detector over all 19 historical spam rows: 1 hit / 19, and the
-- hit is the Lucy Morgan attendee-list pitch this ticket was filed about. The
-- other 18 correctly miss, including the four known false-positive spam rows
-- and a China-domain scam that carries a date AND a place but no event name.
--
-- CLAUDE.md requires a new execution path to ship with its probe, and requires
-- a flag-gated probe to take `enabled_at = NULL` until the flag flips. The flag
-- flips in this same change, so it arms now rather than staying dormant.
--
-- ⚠️ Evidence is the `spam.event_triple` admin_actions row, written on every
-- QUARANTINED spam row — a MISS, not a hit. A probe watching for RECOVERIES
-- would expect roughly one every 2-3 months and would be red almost always.
-- Misses are the high-frequency signal and prove the same thing: it executed.
--
-- Window 504h, MEASURED against spam inter-arrival over 19 rows: 18 gaps, mean
-- 4.3 days, MAXIMUM 14.0 days, none beyond. 336h would sit exactly ON the
-- observed maximum.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'spam-event-triple-detector',
  unixepoch(),
  'OPE-803 - watches admin_actions for action=spam.event_triple, written by the inbound classifier on every quarantined spam row (a MISS, not a hit). Probes that the detector RAN, never what it recovered: a dry-run over the 19 historical rows scored 1 hit / 19, so a recovery-based probe would be red almost always. Window 504h, measured: 18 spam inter-arrival gaps, mean 4.3d, MAX 14.0d, none beyond - 336h would sit exactly on the observed maximum.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
