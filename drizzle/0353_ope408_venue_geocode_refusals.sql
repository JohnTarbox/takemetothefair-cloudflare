-- OPE-408 rework (2026-10-04) — let the nightly geocode sweep converge.
--
-- The sweep re-attempted the same ~45 venues every night (3 identical runs,
-- 10-02 → 10-04: 0 written, 38 low-confidence / 4 duplicate-with /
-- 3 not-a-point), each a billed Places lookup that could never write. The
-- gate's answer is deterministic for an unchanged record, so the sweep now
-- counts refusals per venue and parks one after GEOCODE_PARK_AFTER of them,
-- until the venue's record is edited (updated_at > geocode_last_refused_at).
--
-- Additive only; no data rewritten. Safe on an empty database.
ALTER TABLE venues ADD COLUMN geocode_refusals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venues ADD COLUMN geocode_last_refused_at INTEGER;
