-- OPE-847 — seed the roster vendor-link probe, DORMANT.
--
-- CLAUDE.md (OPE-246) requires a new writer path to ship with its probe in the
-- same PR. This is that probe, and the path is the only one in the inbound
-- pipeline that creates PUBLIC vendor profiles — approved by John in session on
-- 2026-09-07 ("yes, do option (a)").
--
-- ⚠️ `enabled_at` is NULL ON PURPOSE. This is the documented dormant case, not
-- an oversight, and not the flag-gated variant either — it is the third reason
-- a probe may legitimately start dormant: THE WINDOW CANNOT YET BE MEASURED.
--
-- The population that emits this evidence is "submissions whose site publishes
-- a parseable roster". The crawl that produces it (OPE-837) shipped hours ago
-- and has produced ZERO rows. There is no inter-arrival distribution, so any
-- window I wrote today would be an analogy — and a window chosen by analogy is
-- precisely what produced the wrong 72h figure on OPE-830 (real gap: 12 days).
--
-- The trade is explicit: a dormant probe covers nothing, but it also cannot
-- false-fire, and it cannot be mistaken for a measured control. An armed probe
-- carrying a guessed window is worse on both counts — it either cries wolf and
-- gets muted, or it sleeps through the outage it exists to catch, and either
-- way it reads as coverage.
--
-- ARMING CONDITION (do not lose this — a dormant probe nobody arms is the
-- OPE-6 v3.8 failure wearing a different hat):
--
--   1. Wait until `workflow_run_steps` holds enough `secondary-page-crawl`
--      rows to measure the roster-hit rate and the gaps between roster hits.
--   2. Set `expectedWindowHours` in HEARTBEAT_PROBES from that measurement —
--      NOT from the 720 placeholder, which is not a measurement.
--   3. `UPDATE heartbeat_probes SET enabled_at = unixepoch() WHERE probe_name
--      = 'roster-vendor-link';`
--
-- ⚠️ Note for whoever runs the OPE-752 probe audit: this row is EXPECTED to
-- show a NULL `enabled_at`. The 42/42 "every probe has a seed row" check still
-- passes — a seed row exists. What is deliberately absent is the arming.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'roster-vendor-link',
  NULL,
  'OPE-847 - watches workflow_run_steps for step_name=roster-vendor-link, written by the inbound-email workflow whenever the crawled exhibitor roster is linked to an event via create_or_link_vendor (strict dedup). The only inbound path that creates PUBLIC vendor profiles; approved by John 2026-09-07. DORMANT ON PURPOSE: the emitting population (submissions whose site publishes a parseable roster) has zero observations because the OPE-837 crawl shipped the same day, so no window can be measured yet and a guessed one would repeat the OPE-830 analogy error. ARM IT by measuring the roster-hit inter-arrival gaps from secondary-page-crawl rows, setting expectedWindowHours from that measurement (the 720 in the registry is a placeholder, not a measurement), then setting enabled_at.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
