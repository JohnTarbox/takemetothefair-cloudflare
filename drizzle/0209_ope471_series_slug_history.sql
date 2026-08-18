-- OPE-471 — the one missing `*_slug_history` table.
--
-- Six entities already redirect on rename: events, venues, promoters,
-- performers, vendors, blog posts. `event_series` has none, verified against
-- sqlite_master.
--
-- That stayed theoretical until something needed to retire a series slug. The
-- duplicate-parent consolidation needs to retire ~115, and the §8 decision memo
-- is unambiguous: "Whatever scheme we pick MUST 301 the legacy URL to its
-- replacement — that's non-negotiable." It was implemented for the EVENT leg
-- and never for the SERIES leg.
--
-- ── These are not cold URLs ──────────────────────────────────────────────
--
--   /events/the-big-e-eastern-states-exposition-ma   19 clicks · 2,434 impr · pos 5.1
--   /events/the-big-e-eastern-states-exposition      unknown to Google
--
-- The duplicate is the ranking asset; its clean twin does not exist as far as
-- search is concerned. Deleting duplicates without 301s would destroy the only
-- ranking several fairs have and publish ~115 sitemap-listed 404s — and with
-- the Bing IndexNow lane latched (UCM000007097380), recovery would be
-- organic-crawl-only.
--
-- Mirrors `event_slug_history` exactly, including `new_slug`: the walker
-- follows chains, so a slug that moves twice needs each hop recorded rather
-- than only its origin.

CREATE TABLE IF NOT EXISTS series_slug_history (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT
);

-- The lookup the middleware performs on every miss, so it must be indexed.
CREATE INDEX IF NOT EXISTS idx_series_slug_history_old_slug
  ON series_slug_history(old_slug);
CREATE INDEX IF NOT EXISTS idx_series_slug_history_series_id
  ON series_slug_history(series_id);

-- One live redirect per retired slug. Without this a slug retired twice could
-- hold two rows pointing at different targets, and which one won would depend
-- on ordering — the kind of ambiguity a 301 must never have.
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_slug_history_old_slug_unique
  ON series_slug_history(old_slug);
