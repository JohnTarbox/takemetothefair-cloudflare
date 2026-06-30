-- OPE-31 (2026-06-30) — producer-level NO_PUBLIC_LIST rails (Option B).
--
-- Some PRODUCERS never publish exhibitor rosters anywhere (verified via deep
-- research in OPE-22 / OPE-23). Without a producer-wide signal, every research
-- pass re-grinds each of their events into the same NO_PUBLIC_LIST dead-end.
-- This adds promoters.vendor_roster_publishes_lists and, for the two confirmed
-- producers, (a) sets the flag = 0 (false) and (b) back-fills their
-- not-yet-researched events to NO_PUBLIC_LIST. The occurred-sweep
-- (event-occurred-sweep.ts Pass 3) reads the flag for NEW events going forward.
--
-- SAFETY:
--   * (b) only flips events currently NULL or 'NEEDS_RESEARCH' — it NEVER
--     downgrades a researched HAS_ROSTER / PARTIAL / existing NO_PUBLIC_LIST row.
--   * Producer match is by company_name. ⚠️ REVIEW BEFORE APPLYING: confirm these
--     exact names exist in prod `promoters`. A name mismatch makes the UPDATEs a
--     no-op (safe — nothing wrong is written, the backfill just won't run for
--     that producer). The occurred-sweep rails + `update_promoter` still let an
--     operator flag any producer post-deploy, so this migration is not the only
--     path to the flag.

ALTER TABLE promoters ADD COLUMN vendor_roster_publishes_lists integer;

-- (a) Flag the two confirmed producers (verified producer-wide "no public roster").
UPDATE promoters
SET vendor_roster_publishes_lists = 0, updated_at = unixepoch()
WHERE company_name IN (
  'Great New England Craft & Artisan Shows',
  'Hartford Quechee Chamber'
);

-- (b) Back-fill their existing un-researched events to NO_PUBLIC_LIST. Excludes
--     HAS_ROSTER / PARTIAL (and existing NO_PUBLIC_LIST) so no real roster is lost.
UPDATE events
SET vendor_roster_status = 'NO_PUBLIC_LIST', updated_at = unixepoch()
WHERE promoter_id IN (SELECT id FROM promoters WHERE vendor_roster_publishes_lists = 0)
  AND (vendor_roster_status IS NULL OR vendor_roster_status = 'NEEDS_RESEARCH')
  AND merged_into IS NULL;

-- (c) Audit row per flagged producer (actor NULL = system/migration).
INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
SELECT
  lower(hex(randomblob(16))),
  'vendor_roster.producer_no_public_list',
  NULL,
  'promoter',
  id,
  json_object('reason', 'producer never publishes a public roster (OPE-31)', 'company_name', company_name),
  unixepoch()
FROM promoters
WHERE vendor_roster_publishes_lists = 0;
