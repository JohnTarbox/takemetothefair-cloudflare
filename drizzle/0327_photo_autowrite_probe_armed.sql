-- PHOTO_AUTOWRITE_ENABLED flipped to "true" on 2026-09-26 (John, direct, in
-- session). Arm the booth-autowrite heartbeat probe the same day, as its own
-- comment requires (src/lib/heartbeat.ts; seeded NULL by drizzle/0164). Only
-- when still NULL, so a re-run or an already-armed row is untouched; a no-op
-- on an empty database.
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch()
WHERE probe_name = 'booth-autowrite' AND enabled_at IS NULL;
