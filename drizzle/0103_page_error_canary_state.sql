-- Issue #326 — Slack canary for page-level fetcher errors.
--
-- One row per alert tier ('RED' | 'YELLOW') tracking the last dispatch.
-- Used by mcp-server/src/page-error-canary.ts to debounce alerts so a
-- single sustained outage doesn't spam the channel every cron fire.
--
-- Why a state table (not an inline flag on error_logs): error_logs is
-- the raw signal — every page-fetcher catch writes there. The canary's
-- own per-tier dispatch state needs its own lightweight surface, the
-- same way dedup_sweep_snapshots.last_yellow_alerted_at debounces the
-- dedup canary's YELLOW dispatches.
--
-- Why keyed by tier (not by source or window): the canary always
-- evaluates the aggregate across all matching sources within the
-- window — a per-source debounce would double-fire when two surfaces
-- break in the same outage (the case this canary was designed to catch).

CREATE TABLE IF NOT EXISTS page_error_canary_state (
  tier              TEXT PRIMARY KEY,            -- 'RED' or 'YELLOW'
  last_alerted_at   INTEGER NOT NULL,            -- seconds-epoch of last dispatch
  last_count        INTEGER NOT NULL,            -- window error count at that dispatch
  last_top_source   TEXT,                        -- source with most errors at dispatch
  last_top_count    INTEGER                      -- count for that top source
);
