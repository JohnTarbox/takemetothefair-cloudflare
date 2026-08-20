-- OPE-495 — restore the one redirect the unwritten-history defect cost us.
--
-- 2026-08-19: an analyst run applied OPE-475 §2, correcting a promoter named
-- after its event to the real organisation:
--
--   Cape Cod Creative Arts Festival  ->  Creative Arts Center
--   slug: cape-cod-creative-arts-festival -> creative-arts-center
--
-- `update_promoter` regenerated the slug and reported the change in its own
-- response, but never wrote `promoter_slug_history`, so the old URL was orphaned
-- with nothing recording that a redirect was owed. Confirmed live before this
-- migration: /promoters/cape-cod-creative-arts-festival returned 404 while
-- /promoters/creative-arts-center returned 200.
--
-- The code fix ships in the same PR. This restores the single row already lost;
-- it is a one-off repair, NOT a general backfill — no other orphan is knowable,
-- because the defect's whole signature is that nothing was written down. Every
-- pre-existing row in both promoter_slug_history and venue_slug_history was an
-- admin-UI write (`admin-user-001`), so there is no MCP-origin set to sweep.
--
-- `changed_by = 'ope-495-backfill'` rather than an agent id: this row is being
-- reconstructed after the fact by a migration, and saying so is more useful to a
-- future reader than a plausible-looking attribution.
--
-- IDEMPOTENT + EMPTY-DATABASE SAFE. `promoter_slug_history.promoter_id`
-- REFERENCES `promoters(id)`, so on CI's fresh D1 an unguarded INSERT raises
-- FOREIGN KEY constraint failed and aborts the WHOLE migration run — the failure
-- that bit OPE-473. The NOT EXISTS clause makes a re-run a no-op, which
-- INSERT OR IGNORE alone would not, because the id is randomblob(16) and there
-- is no unique index on (promoter_id, old_slug).
INSERT INTO promoter_slug_history (id, promoter_id, old_slug, new_slug, changed_at, changed_by)
SELECT
  lower(hex(randomblob(16))),
  '952a7026-bcc3-4a78-8876-c43952849106',
  'cape-cod-creative-arts-festival',
  'creative-arts-center',
  unixepoch(),
  'ope-495-backfill'
WHERE EXISTS (
    SELECT 1 FROM promoters
     WHERE id = '952a7026-bcc3-4a78-8876-c43952849106'
       AND slug = 'creative-arts-center'
  )
  AND NOT EXISTS (
    SELECT 1 FROM promoter_slug_history
     WHERE promoter_id = '952a7026-bcc3-4a78-8876-c43952849106'
       AND old_slug = 'cape-cod-creative-arts-festival'
  );
