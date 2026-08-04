-- OPE-308 (follow-up) — carry the stale-red STEADY STATE into the Monday inventory.
--
-- The scan now pushes on CHANGE, not on existence, which is what stops the daily
-- mail. The cost of change-only is that a red persisting for weeks would never be
-- mentioned again. These two columns are the mitigation: the scan records how many
-- reds are currently standing, and Monday's inventory reports it like any other
-- backlog number.
--
-- WRITER SPLIT (important — two Workers share this row):
--   stale_red_current / stale_red_current_at  -> written ONLY by the main-app scan
--   stale_red_count (last-Monday snapshot)    -> written ONLY by the MCP inventory
-- Disjoint column sets, so neither clobbers the other and no lock is needed.
ALTER TABLE weekly_inventory_state ADD COLUMN stale_red_current INTEGER;
ALTER TABLE weekly_inventory_state ADD COLUMN stale_red_current_at INTEGER;
ALTER TABLE weekly_inventory_state ADD COLUMN stale_red_count INTEGER;
