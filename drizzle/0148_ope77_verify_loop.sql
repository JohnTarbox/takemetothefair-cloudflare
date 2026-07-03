-- OPE-77 (CPI Move 3 — recommendations "verify loop", 2026-07-03) — hand-authored
-- per the OPE-21 migration workflow (numbering owned by the orchestrator; deploy
-- applies via `wrangler d1 migrations apply` by filename — no meta snapshot).
--
-- Adds the verify-loop columns to recommendation_items. When an operator marks a
-- rule's items "acted" for a rule that participates in the verify loop (only
-- page_1_zero_click_queries in v1), we snapshot the metric at act time and
-- schedule a re-measure. N days (lagDays) later the daily scan re-reads the
-- metric and either clears the item (improved) or re-opens it as an "acted, no
-- movement" learning signal.
--
--   verify_status        → NULL (not participating) | 'pending' (snapshotted,
--                          awaiting re-measure) | 'improved' | 'no_movement'.
--   verify_snapshot      → JSON of the metric captured at act time (copied from
--                          payload_json).
--   verify_due_at        → seconds-epoch; re-measure eligible once now >= this.
--   verify_remeasured_at → seconds-epoch of the re-measure that set improved /
--                          no_movement.
--   verify_after         → JSON of the metric read at re-measure time.
--   verify_reason        → human-readable disposition reason (e.g. "clicks 0 → 3"
--                          or "still 0 clicks (position 6.4)").
--
-- All NULL on every pre-OPE-77 row. Purely additive. Rollback: no-op (the
-- nullable columns are harmless — older code never reads them).

ALTER TABLE `recommendation_items` ADD COLUMN `verify_status` text;
ALTER TABLE `recommendation_items` ADD COLUMN `verify_snapshot` text;
ALTER TABLE `recommendation_items` ADD COLUMN `verify_due_at` integer;
ALTER TABLE `recommendation_items` ADD COLUMN `verify_remeasured_at` integer;
ALTER TABLE `recommendation_items` ADD COLUMN `verify_after` text;
ALTER TABLE `recommendation_items` ADD COLUMN `verify_reason` text;

-- The re-measure endpoint selects `verify_status='pending' AND verify_due_at <= now`.
CREATE INDEX `idx_recommendation_items_verify` ON `recommendation_items` (`verify_status`,`verify_due_at`);
