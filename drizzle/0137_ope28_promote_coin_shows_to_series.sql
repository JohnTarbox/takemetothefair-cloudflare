-- OPE-28 (2026-06-30) — promote the recurring MONTHLY coin shows to event_series
-- so the discovery match-to-series rails (PR #610) route their per-month hits
-- under the series (as event_days) instead of minting month-suffixed siblings.
--
-- These four shows are currently STANDALONE multi-date events (one row each,
-- carrying their monthly dates as event_days) with NO event_series — so
-- matchSeriesByNameVenue can't route a new monthly hit to them. This creates a
-- series per show (recurrence_rule=FREQ=MONTHLY — the signal the OPE-28 rails
-- gate on) and links the existing event as that series' year-occurrence. It also
-- gives each show a series landing page (image inherited from the occurrence per
-- OPE-27).
--
-- SAFETY / idempotency:
--   * Series INSERT is `INSERT ... SELECT FROM events ... ON CONFLICT
--     (canonical_slug) DO NOTHING` — self-inheriting (venue/promoter/categories/
--     tags/audience/access/description come from the live event row at apply
--     time, so no stale hardcoded ids), and a no-op on re-apply.
--   * If an event id is missing (deleted/merged), the SELECT yields no row and
--     the UPDATE matches nothing — safe no-op, never errors.
--   * The link UPDATE only sets series_id when it is still NULL, so it never
--     clobbers an existing series linkage and re-apply is a 0-row no-op.
--   * canonical_slugs verified free of any existing event/series slug
--     (no /events/<slug> route collision) before authoring.
--
-- Verified live (MMATF MCP) 2026-06-30: each is one APPROVED multi-date event.

-- ── Nashua Coin & Stamp Show ──────────────────────────────────────────────
INSERT INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule,
   description, categories, tags, primary_audience, public_access, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'nashua-coin-and-stamp-show', 'Nashua Coin & Stamp Show',
       e.venue_id, e.promoter_id, 'FREQ=MONTHLY',
       e.description, e.categories, e.tags, e.primary_audience, e.public_access,
       unixepoch('now'), unixepoch('now')
FROM events e WHERE e.id = 'b2b40cde-b20d-44ab-9888-427bbe81fca1'
ON CONFLICT(canonical_slug) DO NOTHING;
UPDATE events
SET series_id = (SELECT id FROM event_series WHERE canonical_slug = 'nashua-coin-and-stamp-show'),
    updated_at = unixepoch('now')
WHERE id = 'b2b40cde-b20d-44ab-9888-427bbe81fca1' AND series_id IS NULL;

-- ── Greater Worcester Coin Show ───────────────────────────────────────────
INSERT INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule,
   description, categories, tags, primary_audience, public_access, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'greater-worcester-coin-show', 'Greater Worcester Coin Show',
       e.venue_id, e.promoter_id, 'FREQ=MONTHLY',
       e.description, e.categories, e.tags, e.primary_audience, e.public_access,
       unixepoch('now'), unixepoch('now')
FROM events e WHERE e.id = '057e7d9c-4b17-424c-9876-1a5111edb7b9'
ON CONFLICT(canonical_slug) DO NOTHING;
UPDATE events
SET series_id = (SELECT id FROM event_series WHERE canonical_slug = 'greater-worcester-coin-show'),
    updated_at = unixepoch('now')
WHERE id = '057e7d9c-4b17-424c-9876-1a5111edb7b9' AND series_id IS NULL;

-- ── Devens MA Coin & Currency Show ────────────────────────────────────────
INSERT INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule,
   description, categories, tags, primary_audience, public_access, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'devens-ma-coin-and-currency-show', 'Devens MA Coin & Currency Show',
       e.venue_id, e.promoter_id, 'FREQ=MONTHLY',
       e.description, e.categories, e.tags, e.primary_audience, e.public_access,
       unixepoch('now'), unixepoch('now')
FROM events e WHERE e.id = '151f6737-dfda-4b04-ae84-c2f881975c34'
ON CONFLICT(canonical_slug) DO NOTHING;
UPDATE events
SET series_id = (SELECT id FROM event_series WHERE canonical_slug = 'devens-ma-coin-and-currency-show'),
    updated_at = unixepoch('now')
WHERE id = '151f6737-dfda-4b04-ae84-c2f881975c34' AND series_id IS NULL;

-- ── Brunswick Coin & Stamp Show ───────────────────────────────────────────
INSERT INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule,
   description, categories, tags, primary_audience, public_access, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'brunswick-coin-and-stamp-show', 'Brunswick Coin & Stamp Show',
       e.venue_id, e.promoter_id, 'FREQ=MONTHLY',
       e.description, e.categories, e.tags, e.primary_audience, e.public_access,
       unixepoch('now'), unixepoch('now')
FROM events e WHERE e.id = '6c8ae89c-02f6-483d-b14b-1ad0e3f0fd41'
ON CONFLICT(canonical_slug) DO NOTHING;
UPDATE events
SET series_id = (SELECT id FROM event_series WHERE canonical_slug = 'brunswick-coin-and-stamp-show'),
    updated_at = unixepoch('now')
WHERE id = '6c8ae89c-02f6-483d-b14b-1ad0e3f0fd41' AND series_id IS NULL;
