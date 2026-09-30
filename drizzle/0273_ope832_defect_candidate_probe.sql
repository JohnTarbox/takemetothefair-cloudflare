-- OPE-832 — arm the email defect-candidate detector probe.
--
-- A customer who describes a bug in an email now produces a reviewable
-- `problem_reports` row with `kind='defect_candidate'`. Before this, the defect
-- queue was fed by the web form and by `report@`/`feedback@` only, and
-- `problem_report` intent is assigned by RECIPIENT ADDRESS — so every real
-- email defect report was invisible to it.
--
-- Measured over 180 days in prod (2026-09-07): three distinct customer defect
-- reports, four emails, ALL `intent=support`, ZERO problem_reports. The only
-- two email-sourced rows that exist are both 2026-06-04 — a Cloudflare Email
-- Routing verification notice and a "testinr" smoke test, i.e. the setup
-- traffic for the report@ handler on its ship date.
--
-- CLAUDE.md requires a new writer to ship with its probe in the same PR.
--
-- ⚠️ Watches the RUN, not the yield. At ~1 incident per 60 days a
-- candidate-counting probe would be red almost always and get muted. The
-- `defect-candidate` workflow step row is written on every dispatched email
-- whatever the outcome, so a MISS proves execution as well as a hit.
--
-- Window 240h, MEASURED on this probe's own population (every inbound email
-- reaching the workflow): 83 active days over 180, 82 gaps, mean 1.37 days,
-- MAXIMUM 6.0 days (144h). 72h would have fired on 4 ordinary-quiet gaps, 120h
-- on 1, 168h on none.
--
-- ⚠️ 168h tests clean and is still NOT chosen: all 180 sampled days are fair
-- season, so winter volume is unobserved and very likely quieter. Sizing to
-- summer gaps would start crying wolf in January — the seasonal form of the
-- "chosen by analogy" error OPE-830 corrected twice. 240h buys that margin for
-- at most four extra days of detection latency.
--
-- ARMED, not dormant: the detector ships unflagged in this same change, and the
-- step row is written on the very next inbound email, so there is no
-- first-evidence gap to wait out.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so the fresh D1 that CI builds from migrations applies it
-- without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'email-defect-candidate-detector',
  unixepoch(),
  'OPE-832 - watches max(workflow_run_steps.recorded_at) WHERE step_name=''defect-candidate'', written on every dispatched inbound email whatever the outcome (created / no-defect-language / already-reported / intent-skipped). Deliberately a RUN probe, not a yield probe: measured rate is ~1 real defect email per 60 days, so counting candidates would be red almost always and get muted. Window 240h, measured on inbound-email arrivals: 82 gaps over 180d, mean 1.37d, MAX 6.0d; 168h also tests clean but the sample is entirely fair season, so winter gaps are unmeasured.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
