-- K27 (Dev-Brief-K27, 2026-06-15) — auto-rollover provenance pointer.
--
-- When a recurring event (events.recurrence_rule populated, FREQ=YEARLY)
-- transitions to lifecycle_status='OCCURRED', rolloverEventIfRecurring()
-- creates a TENTATIVE next-occurrence edition that inherits venue/promoter/
-- image/description/price/category. events.rolled_from_event_id on that new
-- edition points back at the SOURCE event (the edition that just passed):
--   rolled_from_event_id IS NULL                  → not an auto-rolled edition
--   rolled_from_event_id = <source-event-id>      → this row was auto-created
--                                                    by K27 from <source>
--
-- Self-FK ON DELETE SET NULL mirrors merged_into (0095) / possible_duplicate_of
-- (0096): if the source is hard-deleted the rolled edition stays, just loses the
-- provenance link. Nullable, no default — existing rows are unaffected.
--
-- Verify not already present:  PRAGMA table_info('events');
ALTER TABLE events ADD COLUMN rolled_from_event_id TEXT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_rolled_from_event_id
  ON events(rolled_from_event_id)
  WHERE rolled_from_event_id IS NOT NULL;
