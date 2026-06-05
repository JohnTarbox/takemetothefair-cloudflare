-- B2 per-source debounce (2026-06-05, REL1' §0 follow-up).
--
-- The original drizzle/0103 keyed page_error_canary_state by tier alone
-- ('RED' | 'YELLOW'), so a sustained outage that affected multiple page
-- fetchers in the same window debounced as one. The B2 PR #332 alert
-- body added the top-5 source breakdown so operators saw WHICH sources
-- spiked, but the dispatch itself still fired once per tier per window.
--
-- This migration extends the PK to (tier, source) so each affected
-- source gets its own debounce window. A burst on `getEvents` alone
-- and a burst on `getVenue` alone now alert independently — useful
-- because a localized regression looks different from a global outage.
--
-- Migration strategy (SQLite has no ALTER PRIMARY KEY):
--   1. Drop the existing table. At most 2 rows ever (RED + YELLOW
--      aggregate state), and we deliberately accept one possible
--      duplicate alert per source on the next fire — the alternative
--      (preserving state with a back-compat `source=''` row) lets the
--      old debounce silence a real per-source signal during the
--      window where the rename happens. The conservative choice is to
--      let the alert fire freely.
--   2. Recreate with composite PK (tier, source).
--   3. New thresholds (in the canary code, not here): per-source RED=10,
--      per-source YELLOW=3 in 10 min. Calibrated against the 2026-06-04
--      outage where per-source rate was ~10/win (vs the aggregate
--      ~42/win that drove the old RED=50 / YELLOW=10 thresholds).

DROP TABLE IF EXISTS page_error_canary_state;

CREATE TABLE page_error_canary_state (
  tier              TEXT    NOT NULL,        -- 'RED' or 'YELLOW'
  source            TEXT    NOT NULL,        -- e.g. 'app/events/page.tsx:getEvents'
  last_alerted_at   INTEGER NOT NULL,        -- seconds-epoch
  last_count        INTEGER NOT NULL,        -- count at the last dispatch
  PRIMARY KEY (tier, source)
);

-- Index on source alone so the canary can quickly look up "all
-- debounce rows for source X" if we ever add a sweep / cleanup
-- step (e.g. drop stale rows for sources that no longer exist).
CREATE INDEX IF NOT EXISTS idx_page_error_canary_state_source
  ON page_error_canary_state (source);
