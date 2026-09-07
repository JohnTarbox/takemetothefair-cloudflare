-- OPE-837 — arm the probe for the submit@ same-site nav crawl.
--
-- CLAUDE.md (OPE-246) requires a new pipeline execution path to ship with its
-- probe, in the same PR. This is that probe, and this path is the OPE-246 class
-- in its purest form: the crawl is ENRICHMENT. It fills empty fields and never
-- fails a submission, so if it silently stops running, every submission still
-- succeeds, every event is still created, and the only symptom is that prices
-- and rosters quietly stop appearing — which is indistinguishable from "the
-- sites we were sent this month didn't publish them."
--
-- ⚠️ Evidence is the `secondary-page-crawl` row in `workflow_run_steps`, NOT a
-- filled price or a roster name. The step is recorded whenever the crawl phase
-- executes, INCLUDING when it considers zero pages and produces nothing. That
-- makes it evidence of EXECUTION rather than of YIELD — the distinction this
-- repo has got wrong before by probing the yield and reading a quiet week as a
-- dead path (see the OPE-803 note in the previous migration for the same
-- reasoning applied to a different signal).
--
-- Window 576h (24 days), MEASURED — and measured against the right COHORT,
-- which changed the answer. The population that emits this evidence is not
-- "URL submissions" but "URL submissions that produced an event", because the
-- crawl phase only runs once a URL source has yielded one. Over 180 days of
-- prod `inbound_emails`:
--
--     all URL submissions:            151 rows, 150 gaps, mean 18.0h, MAX 243.2h
--     ...that produced an event:       80 rows,  79 gaps, mean 33.9h, MAX 371.4h
--
-- Sizing on the first figure would have set the window BELOW the real cohort's
-- observed maximum, so the probe would have gone red on an ordinary quiet
-- fortnight and then been muted. 576h is ~1.55x the measured maximum — the same
-- headroom ratio OPE-803 used — and sits above every gap observed in 180 days.
--
-- ⚠️ Detection is slow by construction (up to 24 days). The signal is slow:
-- this path fires roughly twice a week. A window tight enough to be fast would
-- be a window that cries wolf, and a muted probe reads as coverage while
-- covering nothing.
--
-- Not flag-gated, so it arms now rather than taking `enabled_at = NULL`.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'submit-secondary-page-crawl',
  unixepoch(),
  'OPE-837 - watches workflow_run_steps for step_name=secondary-page-crawl, written by the inbound-email workflow whenever the same-site nav crawl phase executes, including when it considers zero pages. Probes EXECUTION, never yield: an enrichment path that stops running is silent by construction, because every submission still succeeds and only the price/roster reach disappears. Window 576h, measured on the emitting cohort (URL submissions that produced an event): 79 gaps over 180d, mean 33.9h, MAX 371.4h. The wider all-URL-submission cohort maxes at 243.2h and would have produced a window below the real maximum.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
