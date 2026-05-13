-- Per-rule last-scan-error column for the recommendations engine.
--
-- The engine catches per-rule exceptions in scanAll() (added in PR #148)
-- and continues with the next rule on failure. Before this column, the
-- error message was only visible via console logs and the scan endpoint's
-- HTTP response — not durable, not surfaceable in the admin UI.
--
-- Now: engine writes the error message here on per-rule failure (keeps
-- last_scanned_at frozen so prior success timestamp is preserved) and
-- clears it to NULL on per-rule success. Admin recommendations tab reads
-- the column to render a red banner on rules whose last scan threw.
--
-- See src/lib/recommendations/engine.ts:scanAll for the write path.
-- See src/app/admin/analytics/page.tsx:RecommendationsTab for the read.
-- Migration added 2026-05-13.

ALTER TABLE recommendation_rules ADD COLUMN last_scan_error TEXT;
