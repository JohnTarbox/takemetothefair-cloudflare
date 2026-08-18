-- OPE-423 — un-stick the half-merged Bar Harbor fair so the re-merge can run
-- in the direction John decided (option A: keeper = bar-harbor-fall-craft-fair-2026).
--
-- ── State this repairs ───────────────────────────────────────────────────
--
--   9a395062  bar-harbor-fall-craft-fair-2026      APPROVED, merged_into=4fddcd5e
--   4fddcd5e  arts-at-atlantic-oceanside-october   APPROVED, merged_into=NULL
--
-- The 2026-06-01 merge was clean; on 2026-06-25 the tombstone was RESURRECTED
-- (status back to APPROVED, slug renamed back) because no write path on
-- `events` consulted `merged_into`. PR #883 closed that hole. What is left is
-- the one stranded row, and it is worse than the ticket recorded:
--
--   $ curl -sI /events/bar-harbor-fall-craft-fair-2026
--     HTTP/2 301 → /events/arts-at-atlantic-oceanside-october/2026
--
-- The APPROVED row with 1,190 views, the real organizer (Island Arts
-- Association) and the town+type+year slug is NOT "live and indexable" as §1
-- assumed — it is unreachable, redirecting its own equity to the row sourced
-- from an aggregator whose promoter is the venue. Two rows are approved; only
-- the wrong one is reachable.
--
-- ── Why the slug-history row must go FIRST ───────────────────────────────
--
-- `2f8a375f` says bar-harbor-fall-craft-fair-2026 → arts-at-atlantic-oceanside-october.
-- That row IS the 301 above. Left in place, re-merging in the opposite
-- direction would add the mirror hop and build a cycle — the exact outcome
-- `merge_events(preview: true)` caught when this ticket was filed. The walker
-- is cycle-safe (seen-set + 5-hop cap, verified in PR #883), so this would not
-- hang; it would just silently strand the page again.
--
-- Deleting it loses nothing: it describes a merge that was undone in June. The
-- two rows that stay are both real renames of the surviving event:
--   80bca8a1  2026-bar-harbor-fall-craft-fair          -> bar-harbor-fall-craft-fair-2026
--   3b5b36a4  bar-harbor-fall-craft-fair-2026-merged-… -> bar-harbor-fall-craft-fair-2026
-- After this deletion both resolve to the live page instead of chaining away.
--
-- ── Discipline (docs/bulk-mutation-discipline.md) ────────────────────────
--
-- Single-writer: this file is the only writer. Idempotent: every statement is
-- guarded on the exact pre-state, so a re-run is a no-op rather than an error.
-- Read-back verified: the health report's `merged_tombstone_invariant` must go
-- to 0 violations. Rollback: re-running the merge in the original direction
-- restores the June state exactly; nothing here is unrecoverable.
--
-- This does NOT perform the merge. That runs afterwards through `merge_events`
-- with `preview: true` first, per John's condition on this ticket — so the
-- redirect and the tombstone are written by the audited tool, not by hand.

-- 1. Release the stale pointer. Guarded on the exact target so this cannot
--    clear a pointer written by some later, legitimate merge.
UPDATE events
   SET merged_into = NULL
 WHERE id = '9a395062-d021-4b40-862d-9368c3966fa6'
   AND merged_into = '4fddcd5e-56de-4ec5-800b-143905324198';

-- 2. Drop the redirect that is stranding the live page. Keyed by primary key,
--    so it is exactly one row and re-running removes nothing.
DELETE FROM event_slug_history
 WHERE id = '2f8a375f-d445-49f7-aac5-af472c2d6af2';

-- 3. Audit row. The whole reason this is a migration and not a console write:
--    a production data change with no actor and no record is what this ticket
--    refused to do by hand. INSERT OR IGNORE on a fixed id keeps it idempotent.
INSERT OR IGNORE INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
VALUES (
  'ope423-clear-stale-merge-pointer',
  'event.merge_pointer_clear',
  NULL,
  'EVENT',
  '9a395062-d021-4b40-862d-9368c3966fa6',
  '{"ope":"OPE-423","reason":"half-completed merge resurrected 2026-06-25; clearing stale merged_into and the slug-history hop so the re-merge can run with keeper=bar-harbor-fall-craft-fair-2026 (John, option A, 2026-08-17)","cleared_merged_into":"4fddcd5e-56de-4ec5-800b-143905324198","deleted_slug_history_id":"2f8a375f-d445-49f7-aac5-af472c2d6af2"}',
  unixepoch()
);
