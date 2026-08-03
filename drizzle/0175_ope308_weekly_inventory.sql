-- OPE-308 (alert diet E2) — state for the weekly Monday inventory summary.
--
-- Holds LAST MONDAY's three backlog counts so the summary can show a
-- week-over-week delta. "142" tells an operator very little; "142 (+37)" tells
-- them whether to act. `last_sent_date` doubles as the once-per-Monday guard,
-- date-keyed rather than elapsed-days so a missed week doesn't permanently
-- shift the cadence.
--
-- Nullable counts on purpose: the first run has no prior week, and the delta
-- column renders "—" rather than inventing a +N against zero.

CREATE TABLE IF NOT EXISTS weekly_inventory_state (
  id TEXT PRIMARY KEY,
  last_sent_date TEXT,
  roster_research_count INTEGER,
  promoter_enrichment_count INTEGER,
  goodwill_open_count INTEGER,
  updated_at INTEGER
);
