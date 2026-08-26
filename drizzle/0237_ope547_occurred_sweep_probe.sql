-- OPE-547 — heartbeat probe for the daily OCCURRED transition + roster sweep.
--
-- Per OPE-246 a probe ships WITH the writer, like a migration. This sweep has
-- run nightly since K27 with no probe at all, and that is exactly how its
-- defect survived: Pass 3 keyed on `lifecycle_status = 'OCCURRED'`, so 123 past
-- TENTATIVE events were never evaluated, and nothing anywhere said so. The
-- sweep reported success every night while a whole population went unseen.
--
-- Watches the RUN, not the yield. The yield is not probeable here and that is
-- not a limitation, it is the point: Pass 1 transitions nothing on a day when
-- no event ends, and Pass 3's enqueue count correctly falls to zero once the
-- backlog drains. A probe on either would go red on a quiet week rather than on
-- a dead cron — the false-fire OPE-541 shipped and had to correct the next day.
-- The sweep now stamps agent_heartbeats on EVERY run and this watches the stamp.
--
-- enabled_at is set NOW rather than NULL: the run stamp ships in the same PR
-- and is not behind a flag, so the probe has evidence to find from the first
-- nightly run after deploy. If the stamp were flag-gated this would be NULL
-- until the flag flipped, because a probe with no possible evidence is a
-- guaranteed false red.
--
-- No-op on an empty database (a bare INSERT with ON CONFLICT DO NOTHING, no
-- foreign keys) so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'occurred-transition-sweep',
  unixepoch(),
  'OPE-547 — watches agent_heartbeats.last_seen_at for agent_code=watchdog:occurred-sweep. Probes that the daily sweep RAN, never what it produced: both its yields legitimately reach zero, and a zero yield is indistinguishable from a dead cron.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
