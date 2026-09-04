-- OPE-791 — stamp the ONE appearance that escaped.
--
-- `link_performer_to_event` / `create_or_link_performer` both REQUIRE
-- `source_url` — the caller has just grounded the appearance — but neither
-- wrote `last_verified_at`, so a fresh appearance was born "never verified" and
-- read as stale to the OPE-123 freshness rail. Fixed in the writer; this stamps
-- the row that got past it.
--
-- ⚠️ ONE row, deliberately. 238 nulls in the pre-2026-08-25 cohort are
-- pre-OPE-123 rows and are NOT evidence of this bug. Backfilling them would
-- manufacture a verification claim for appearances nobody has re-grounded —
-- exactly the OPE-433 `dates_confirmed DEFAULT true` trap, which asserted
-- something nobody checked. They stay NULL, honestly.
--
-- Guarded on `last_verified_at IS NULL` so it is idempotent: re-applying will
-- not overwrite a stamp somebody has since set for a real reason. And it uses
-- the row's OWN source_url rather than a literal, so the recorded source is the
-- evidence that actually exists.
--
-- No-op on an EMPTY database (the row does not exist), so CI's fresh-D1
-- migration run is unaffected.
UPDATE event_performers
   SET last_verified_at     = created_at,
       last_verified_source = source_url
 WHERE id = '1dfc38ae-e0fc-4c55-83f3-a3355acb2887'
   AND last_verified_at IS NULL
   AND source_url IS NOT NULL;
