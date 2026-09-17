-- OPE-611 — record a lifecycle CHECK, not only a transition.
--
-- `lifecycle_reason` is written only when lifecycle_status changes, so a
-- TENTATIVE event a human verified against the organizer and deliberately held
-- read back identical to one nobody had opened. Five drain passes re-worked
-- their predecessors' holds for that reason. Both columns are nullable and
-- nothing backfills them: NULL means "never checked", which is true.
ALTER TABLE events ADD COLUMN lifecycle_last_checked_at INTEGER;
ALTER TABLE events ADD COLUMN lifecycle_check_note TEXT;
