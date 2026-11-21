-- OPE-1630 — the feed review step.
--
-- promoter_feed_items.review_state gains 'rejected' (TEXT, no CHECK — the enum
-- lives in the Drizzle schema). A rejected item is remembered by
-- (feed_id, external_id): later reads keep it rejected and never re-queue it.
--
-- Who decided, when, and why — for every review action (approve / link / reject):
--   review_note — the reviewer's note; for a rejection, the reason.
--   reviewed_at — when the action was taken.
--   reviewed_by — the acting admin user id (NULL for the internal-key path).
--
-- Applies cleanly to an EMPTY db: three nullable columns, no data touched.

ALTER TABLE promoter_feed_items ADD COLUMN review_note TEXT;
ALTER TABLE promoter_feed_items ADD COLUMN reviewed_at INTEGER;
ALTER TABLE promoter_feed_items ADD COLUMN reviewed_by TEXT;
