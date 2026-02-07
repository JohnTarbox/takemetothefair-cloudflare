-- Add unique constraint for non-null Google Place IDs
-- Multiple venues CAN have NULL googlePlaceId (it's optional)
-- But if a venue has one, it must be unique across all venues
CREATE UNIQUE INDEX IF NOT EXISTS `idx_venues_google_place_id_unique`
ON `venues` (`google_place_id`)
WHERE `google_place_id` IS NOT NULL;
