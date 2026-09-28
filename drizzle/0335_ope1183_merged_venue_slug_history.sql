-- OPE-1183 — the parked `*-merged-<id8>` slug of every existing venue merge
-- tombstone gets a history row pointing where its ORIGINAL slug already points.
--
-- merge_venue recorded only `original -> keeper`, so the 13 tombstone URLs
-- 404'd (the middleware fix alone cannot help a slug with no history). Going
-- forward merge_venue writes both rows; this backfills the existing ones.
--
-- Read-derived (dry run on prod 2026-09-28: 13 rows, all to a live keeper),
-- idempotent, and a no-op on an empty database: rows come only
-- from existing (tombstone, history) pairs, and NOT EXISTS skips any slug that
-- already has a row. Rollback: DELETE FROM venue_slug_history WHERE
-- changed_by = 'OPE-1183 backfill'.

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), h.venue_id, v.slug, keeper.slug, unixepoch(), 'OPE-1183 backfill'
FROM venues v
JOIN venue_slug_history h
  ON h.old_slug = substr(v.slug, 1, instr(v.slug, '-merged-') - 1)
-- The keeper's CURRENT slug, via the history row's venue_id (merge_venue
-- records the keeper there). Two keepers were later renamed back to the freed
-- original slug with no history row (deerfield-fair-1 -> deerfield-fairgrounds,
-- farmington-fair -> farmington-fairgrounds), so the recorded new_slug is dead.
JOIN venues keeper
  ON keeper.id = h.venue_id AND keeper.status <> 'INACTIVE'
WHERE v.status = 'INACTIVE'
  AND instr(v.slug, '-merged-') > 0
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history x WHERE x.old_slug = v.slug);
