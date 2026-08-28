-- OPE-408 — heartbeat probe for the nightly 08:30 venue-geocode sweep.
--
-- Per OPE-246 a probe ships WITH the writer. The sweep itself shipped in the
-- original OPE-408 PR (#868) with no probe, and that omission is why this
-- ticket needed a second pass: the only D1 trace a sweep left was the
-- `venue.update` row each SUCCESSFUL geocode writes, and success otherwise went
-- to a `console.log` nobody can query.
--
-- Watches the RUN, not the yield, and here that distinction is load-bearing
-- rather than stylistic. This sweep drains a FINITE backlog, so its yield is
-- supposed to fall to zero: on a night when every venue still missing a pin is
-- legitimately refused (low-confidence, non-point, or resolving to a Place
-- another venue already owns), a perfectly healthy sweep writes nothing. Two of
-- the ten nights to 2026-08-28 wrote zero rows. A yield probe would have gone
-- red on both, and a probe that cries wolf on correct behaviour gets muted,
-- which is worse than no probe.
--
-- The same PR makes the route emit one `venue.geocode.sweep` admin_actions row
-- per `missing_only` call regardless of outcome. Its absence therefore means
-- the cron stopped executing — the only failure here worth paging about.
--
-- enabled_at is set NOW rather than NULL: the run record ships in this same PR
-- and is behind no flag, so the probe has evidence to find from the first
-- nightly run after deploy. A flag-gated writer would take NULL instead,
-- because a probe with no possible evidence is a guaranteed false red.
--
-- No-op on an empty database (a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys) so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'venue-geocode-sweep',
  unixepoch(),
  'OPE-408 — watches admin_actions for action=venue.geocode.sweep, written once per missing_only call by /api/admin/venues/geocode-venues. Probes that the 08:30 cron RAN, never what it wrote: the sweep drains a finite backlog, so a zero-write night is correct behaviour and indistinguishable from a dead cron.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
