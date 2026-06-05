-- B2 (Dev backlog 2026-06-05): reproduce the gsc_monthly_summary table
-- in repo migrations. Same shape as drizzle/0097_gsc_milestone_emails.sql
-- (K10) — an out-of-band table created in prod via the Cloudflare D1 API
-- to back monthly GSC performance email snapshots, invisible to the
-- codebase until this migration lands.
--
-- IF NOT EXISTS makes this migration a no-op against current prod (table
-- already exists with these exact columns; May 2026 row seeded:
-- 668 clicks / 40.1K impressions / 1.67% CTR) and reproduces it on a
-- fresh DB (local dev / CI / new environments).
--
-- Holds GSC "monthly performance" emails — the longer-window counterpart
-- to gsc_milestone_emails. Nothing populates this automatically yet (the
-- May row was manually inserted as Google sent the email); a future cron
-- could snapshot via the GSC API or inbox-parser.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('gsc_monthly_summary');
-- — expected on prod: row already present with these column shapes
-- (this migration is the structural reproduction, not a new create).

CREATE TABLE IF NOT EXISTS gsc_monthly_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,                        -- e.g. '2026-05'
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,                               -- 0–1
  pages_with_first_impressions INTEGER,
  desktop_clicks INTEGER,
  mobile_clicks INTEGER,
  tablet_clicks INTEGER,
  site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
  source TEXT NOT NULL DEFAULT 'google_search_console_email',
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_monthly_unique
  ON gsc_monthly_summary (site_url, year_month);
