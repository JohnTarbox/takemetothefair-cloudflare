-- OPE-1069 — record "the organizer publishes no closing time" as a settled
-- finding, distinct from "we have not found the closing time". The review
-- flag's hours rule (packages/db-schema/src/hours-review-flag.ts) treats a NULL
-- close_time as unknown only when this is 0. Default 0 = today's behaviour for
-- every existing row.
ALTER TABLE event_days ADD COLUMN close_time_unpublished INTEGER NOT NULL DEFAULT 0
  CHECK (close_time_unpublished IN (0, 1));
