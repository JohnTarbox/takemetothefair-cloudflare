-- OPE-363 — seed the heartbeat probe that watches the synthetic funnel canary.
--
-- Per OPE-246 the probe ships WITH the writer, not as a follow-up. The writer
-- here is POST /api/internal/funnel-canary, called by the daily Funnel Canary
-- workflow after every run, pass or fail.
--
-- ---------------------------------------------------------------------------
-- Why a probe when the CI job already goes red
-- ---------------------------------------------------------------------------
--
-- A red job says "the canary ran and failed". Nothing says "the canary stopped
-- running". A deleted schedule, an expired INTERNAL_API_KEY, a disabled
-- workflow, or a GitHub Actions outage all look exactly like a healthy green
-- week -- there is simply no red job to notice.
--
-- That is precisely the 2026-08-05 -> 08-09 failure: the account's quota ran out,
-- every scheduled session died silently for four days, and every dead-man check
-- we had was running on the thing it was watching. OPE-348 fixed that for the
-- agent layer with a Cloudflare cron; this row does the same job for the canary,
-- from a different system (D1 freshness, read by the OPE-75 digest) than the one
-- that runs it (GitHub Actions).
--
-- Job-red catches a broken funnel. Probe-stale catches a broken canary. Neither
-- substitutes for the other.
--
-- ---------------------------------------------------------------------------
-- enabled_at = now, not NULL
-- ---------------------------------------------------------------------------
--
-- The canary is not behind a feature flag; it starts running on its next
-- scheduled tick. A dormant probe would simply never fire. The 48h window in
-- src/lib/heartbeat.ts is measured against a DAILY schedule, so one missed run
-- is a blip (runner outage, rate limit) and two is a pattern.
--
-- Note the heartbeat row is keyed `canary:funnel` with kind='canary'. The three
-- liveness questions in agent_heartbeats -- is the agent layer alive
-- (kind='agent'), is the watchdog alive (kind='watchdog'), is the canary alive
-- (kind='canary') -- share one table and MUST stay pinned to their own kind, or
-- one writer can silence another's alarm.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'funnel-canary',
  unixepoch(),
  'OPE-363 — daily Playwright canary stamps canary:funnel after every run, pass or fail',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
