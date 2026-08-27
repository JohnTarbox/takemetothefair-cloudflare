-- OPE-588 — heartbeat probe for the GSC sweep's FILLER tiers.
--
-- Tiers 1, 2, 2c and REL5 have been unreachable in production since OPE-91.
-- `fillerBudget = max(0, batchSize - guaranteed.size)`, `guaranteed` pinned at
-- 50 once the site passed 10 rows per type, and the nightly cron calls the
-- sweep route with no batchSize — which the route defaults to 8. So the
-- subtraction has been max(0, 8 - 50) = 0 every night for two months.
--
-- Nothing reported it because a tier that selects nothing looks exactly like a
-- tier with nothing to select: no error, no log line, no failing test. That is
-- the OPE-246 class precisely.
--
-- ⚠️ Seeded DORMANT (enabled_at NULL).
--
-- The probe watches a heartbeat the sweep only stamps when filler selected at
-- least one URL, and that stamp ships in the same PR — so at seed time the
-- table has NO evidence and an enabled probe would RED on its first run for a
-- fix that is working. Enable it after the first nightly sweep confirms the
-- stamp lands (06:00 UTC), which is also the acceptance evidence this ticket
-- asks for: a filler-tier URL in a real run, not a test fixture.
--
--   UPDATE heartbeat_probes
--      SET enabled_at = unixepoch(), updated_at = unixepoch()
--    WHERE probe_name = 'gsc-sweep-filler-tiers';
--
-- Pure insert into a probe-registry table with no FK to any other data, so this
-- is a clean no-op against the empty D1 that CI builds from migrations.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'gsc-sweep-filler-tiers',
  NULL,
  'OPE-588 — watches max(agent_heartbeats.last_seen_at) for watchdog:gsc-sweep-filler, stamped only when the filler tiers selected work. Deliberately a yield probe despite OPE-547''s warning: zero filler is never a quiet week, because fillerBudget is derived from constants and tier 2c cannot run dry while ~2,200 sitemap URLs rotate a few per type per night. DORMANT until the first nightly sweep proves the stamp lands.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
