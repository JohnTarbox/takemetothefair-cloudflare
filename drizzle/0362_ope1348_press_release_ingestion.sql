-- OPE-1348 — events created from an organizer's press release get their own
-- ingestion lane. Before this, `source_label: "press-release"` was not a
-- classifier key, so the domain fallback stamped `direct_scrape`.
--
-- Backfill keyed on the LABEL, not one id, so any press-release event created
-- between filing and deploy (Mystic CT / Middleborough MA from the same
-- producer were pending) is corrected too. Measured 2026-10-14: exactly one
-- row, 1b7ecd53 (rhode-island-holiday-light-show-2026).
--
-- Idempotent and a no-op on an empty DB: the WHERE requires the wrong value.
UPDATE events
SET ingestion_method = 'press_release'
WHERE lower(trim(source_name)) IN ('press-release', 'press_release')
  AND ingestion_method = 'direct_scrape';
