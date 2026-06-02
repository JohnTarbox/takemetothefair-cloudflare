-- K10 (analyst, 2026-06-01 EVE): reproduce the gsc_milestone_emails table
-- in repo migrations. Table was created out-of-band in prod via the
-- Cloudflare D1 API earlier today to back the SEO milestone growth chart
-- (B2 / K11) we built in Cowork. Same hygiene gap as the slug-generator
-- (#120) and content_links UNIQUE-index findings — out-of-band tables
-- are invisible to the codebase and to anyone reading the schema.
--
-- IF NOT EXISTS makes this migration a no-op against current prod
-- (table already exists with these exact columns) and reproduces it on
-- a fresh DB (local dev / CI / new environments).
--
-- Holds GSC "Congrats on X clicks in 28 days" milestone emails. 8 rows
-- seeded so far in prod (clicks milestones 20 → 600 spanning Mar 1 →
-- May 31 2026). Nothing populates this automatically — a future
-- enhancement could snapshot the GSC clicks figure via a cron or
-- inbound-email parser. For now, rows are added manually as Google
-- sends the milestone emails.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('gsc_milestone_emails');
-- — expected on prod: rows already present with these column shapes
-- (this migration is the structural reproduction, not a new create).

CREATE TABLE IF NOT EXISTS gsc_milestone_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL DEFAULT 'clicks',
  window_days INTEGER NOT NULL DEFAULT 28,
  threshold INTEGER NOT NULL,
  reached_date TEXT,                -- Google's cited impact date, nullable
  email_date TEXT NOT NULL,
  site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
  source TEXT NOT NULL DEFAULT 'google_search_console_email',
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_milestone_unique
  ON gsc_milestone_emails (metric, window_days, threshold, email_date);
