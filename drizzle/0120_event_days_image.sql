-- F2 (Dev-Email-2026-06-08 §F.2, 2026-06-08) — event_days image_url +
-- focal-point columns.
--
-- Per-occurrence image: a series event with different art per occurrence
-- can crop each occurrence correctly. Mirrors the drizzle/0115 pattern
-- for events/venues/vendors/promoters and the F1 (drizzle/0119) shape
-- for blog_posts.
--
-- Scope of consumers in v1 (declared explicitly in PR #410 description
-- so the new columns don't sit as unconsumed stubs):
--   - WIRED: admin create_event_day / update_event_day MCP tools accept
--     new args; the print sheet (PR #407) and DailyScheduleDisplay can
--     consume image_url as a per-day hero when present.
--   - NOT WIRED (declared deferred): public per-day image strip on
--     /events/<slug>; JSON-LD subEvent.image; series-event grid using
--     per-occurrence art.
--
-- All three new columns are nullable / default 0.5 so existing rows are
-- unchanged.

ALTER TABLE event_days ADD COLUMN image_url TEXT;
ALTER TABLE event_days ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE event_days ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;
