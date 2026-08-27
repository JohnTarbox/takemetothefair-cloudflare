-- OPE-588 — enable the filler-tier probe now that the stamp is proven.
--
-- 0238 seeded it DORMANT because the heartbeat it watches shipped in the same
-- PR: at seed time there was no evidence, and an enabled probe would have RED'd
-- on its first sweep for a fix that was working.
--
-- The evidence now exists. A real sweep on 2026-08-27 21:13:06Z recorded:
--
--   agent_heartbeats: watchdog:gsc-sweep-filler  note="filler=6 guaranteed=20"
--   run result:       inspected=17  deadlineSkipped=3
--
-- filler=6 is the first time the filler tiers have selected work since OPE-91,
-- and the run RETURNED a response rather than being killed at 300s — the
-- deadline cut 3 URLs and said so, which is the whole point of the change.
--
-- Idempotent: sets enabled_at only while it is still NULL, so re-applying this
-- migration cannot stamp a fresh date over the real one, and it is a clean
-- no-op against the empty D1 that CI builds from migrations (the row is
-- inserted by 0238 in the same run, then updated here).
UPDATE heartbeat_probes
   SET enabled_at = unixepoch(),
       updated_at = unixepoch()
 WHERE probe_name = 'gsc-sweep-filler-tiers'
   AND enabled_at IS NULL;
