-- 0055: §10.2 event completeness tracking.
--
-- Same cached 0-100 score as vendors. Powers the sitemap quality gate
-- (events.completeness_score >= 40 to appear in /sitemap.xml).

ALTER TABLE events ADD COLUMN completeness_score INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_events_completeness_score ON events(completeness_score);

-- One-time backfill from current column values.
-- Rubric (sums to 100):
--   description (30) | start+end (20) | venue OR statewide (15)
--   categories non-empty (15) | image_url (10) | price min OR max (10)
UPDATE events
SET completeness_score =
  (CASE WHEN description IS NOT NULL AND TRIM(description) != '' THEN 30 ELSE 0 END) +
  (CASE WHEN start_date IS NOT NULL AND end_date IS NOT NULL THEN 20 ELSE 0 END) +
  (CASE WHEN venue_id IS NOT NULL OR is_statewide = 1 THEN 15 ELSE 0 END) +
  (CASE WHEN categories IS NOT NULL AND categories != '[]' AND TRIM(categories) != '' THEN 15 ELSE 0 END) +
  (CASE WHEN image_url IS NOT NULL AND TRIM(image_url) != '' THEN 10 ELSE 0 END) +
  (CASE WHEN ticket_price_min_cents IS NOT NULL OR ticket_price_max_cents IS NOT NULL THEN 10 ELSE 0 END)
WHERE completeness_score = 0;
