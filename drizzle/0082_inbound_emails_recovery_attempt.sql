-- Stale-sweep retry counter on inbound_emails.
--
-- Caps the infinite-loop scenario the stale-sweep's existing docblock
-- explicitly warns about: "if the original failure mode is deterministic
-- AND not fixed by a deploy in between sweeps, the same row will be
-- picked up again next cycle." Root-caused 2026-05-19 hamxposition.org
-- AI-extract NonRetryableError loop — 5 cycles before mark-done settled.
--
-- Semantics:
--   - Default 0; sweep increments by 1 on each Pattern-B recreate.
--   - When the post-increment value would exceed MAX_RECOVERY_ATTEMPTS
--     (3), sweep stops recreating, marks row status='failed' with
--     reply_kind='sweep-exceeded', and sends a terminal auto-reply.
--   - Pre-existing rows get 0 by virtue of DEFAULT — they're typically
--     already in a terminal status, so sweep won't touch them.

ALTER TABLE inbound_emails ADD COLUMN recovery_attempt_n INTEGER NOT NULL DEFAULT 0;
