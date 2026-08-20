-- OPE-456 — backfill the nine threshold crossings Google never awarded a badge for.
--
-- Ruling (analyst-claude-cowork, 2026-08-20): option 3 — the chart plots BOTH
-- our derived threshold crossings and Google's awarded badges, distinguished by
-- `source`, so neither pretends to be the other. They answer different
-- questions: the derivation is "when did we actually cross this number", the
-- badge is "what did Google choose to tell us about".
--
-- ⚠️ These are NOT tagged `google_search_console_email`. Row 13's own note
-- records that Google skipped the 2K and 2.5K badges outright (it jumped
-- 1.5K → 3K), so writing these as badges would invent awards that were never
-- made — the fabricated-fact class OPE-432 and OPE-433 exist to prevent, aimed
-- at our own scoreboard. `source='derived_from_gsc_daily_totals'` and
-- `reached_date_source='derived'` keep them honest and separable.
--
-- Dates come from a rolling 28-day sum over `gsc_daily_totals` (200 days,
-- 2026-01-30 → 2026-08-17). The derivation earned the right to be trusted by
-- reproducing 13 of 13 human-entered rows exactly across five months and
-- thresholds from 40 to 7,000, and three of these nine were independently
-- recomputed by the reviewer on 08-18 (9K → 08-01, 10K → 08-08 at 10,306,
-- 11K → 08-12) and match to the day.
--
-- `email_date` is set to the reached date because there IS no email; the
-- column is NOT NULL and feeds the chart's x-ordering. `source` is what
-- distinguishes these, not a sentinel date.
--
-- Idempotent by construction: UNIQUE(metric, window_days, threshold, email_date)
-- makes INSERT OR IGNORE a true no-op on re-run. Pure inserts with no foreign
-- keys, so this is also a clean no-op against the empty D1 that CI builds from
-- migrations.

INSERT OR IGNORE INTO gsc_milestone_emails
  (metric, window_days, threshold, reached_date, reached_date_source, email_date, site_url, source, note, created_at)
VALUES
  ('clicks', 28,   100, '2026-05-04', 'derived', '2026-05-04', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 102.',   unixepoch()),
  ('clicks', 28,   500, '2026-05-27', 'derived', '2026-05-27', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 508.',   unixepoch()),
  ('clicks', 28,  2000, '2026-06-27', 'derived', '2026-06-27', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing; Google skipped the 2K badge. 28d total 2023.',  unixepoch()),
  ('clicks', 28,  2500, '2026-07-01', 'derived', '2026-07-01', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing; Google skipped the 2.5K badge. 28d total 2601.', unixepoch()),
  ('clicks', 28,  4000, '2026-07-08', 'derived', '2026-07-08', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 4294.',  unixepoch()),
  ('clicks', 28,  8000, '2026-07-27', 'derived', '2026-07-27', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 8056.',  unixepoch()),
  ('clicks', 28,  9000, '2026-08-01', 'derived', '2026-08-01', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 9059.',  unixepoch()),
  ('clicks', 28, 10000, '2026-08-08', 'derived', '2026-08-08', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 10306.', unixepoch()),
  ('clicks', 28, 11000, '2026-08-12', 'derived', '2026-08-12', 'https://meetmeatthefair.com/', 'derived_from_gsc_daily_totals', 'OPE-456 — derived crossing, no Google badge. 28d window total 11001.', unixepoch());
