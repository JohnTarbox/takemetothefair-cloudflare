-- OPE-344 — Google's own monthly figures, stored as an EXTERNAL oracle.
--
-- Every internal GSC number comes from one API. An error in that ingest is
-- invisible from inside, because there is nothing independent to disagree with
-- it. That is exactly how a 65% click undercount ran unnoticed for months until
-- a human happened to compare July's email by hand (3,305 stored vs Google's
-- 9,370). This table makes that comparison automatic and monthly.
--
-- Values are stored BOTH parsed and verbatim: Google rounds ("9.37K" is not
-- exactly 9,370), so keeping its own text is what later lets a reader tell a
-- parse bug from Google's rounding.
CREATE TABLE IF NOT EXISTS gsc_monthly_oracle (
  month TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pages_with_first_impressions INTEGER,
  raw_clicks TEXT,
  raw_impressions TEXT,
  raw_pages TEXT,
  email_date TEXT NOT NULL,
  -- The three-way comparison recorded at ingest, so a later reader sees what
  -- was true THEN rather than re-deriving it against today's data.
  api_clicks INTEGER,
  dimensioned_clicks INTEGER,
  api_divergence REAL,
  updated_at INTEGER NOT NULL
);

-- OPE-246 first-evidence. Monthly cadence, so the window is generous: ~40 days
-- covers a late send without false-firing. Enabled now — the August email
-- (~Sept 4) is the first unattended proof.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'gsc-monthly-oracle',
  unixepoch(),
  'OPE-344 — Google monthly Search performance email auto-ingested as external oracle',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;
