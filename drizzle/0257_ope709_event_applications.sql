-- OPE-709 — application ROUTES per event. Ruled (c) by John 2026-08-31.
--
-- `events.application_url` held exactly ONE route, and all 105 rows using it are
-- the commercial-vendor lane (verified against prod 2026-08-31: 105 rows, 98
-- APPROVED). Zero are exhibitor entries — so a photographer asking how to enter
-- a fair's photography contest could not be answered from our own data.
--
-- ── This migration must be a no-op on an EMPTY database ───────────────────
--
-- CI applies every migration to a fresh D1. The backfill below is written as
-- INSERT ... SELECT ... FROM events, so on an empty database it selects zero
-- rows and inserts zero rows by construction — no guard needed, and no way to
-- abort the run. (An FK-bearing insert of literal ids is what aborts it.)
--
-- ── Units ─────────────────────────────────────────────────────────────────
--
-- `events.application_deadline` is epoch SECONDS, noon-anchored (verified in
-- prod: 1772280000 = 2026-02-28 12:00:00). `closes_at` is the same, so the copy
-- below is a straight column move. Do NOT introduce a *1000 here.

CREATE TABLE IF NOT EXISTS event_applications (
  id            TEXT PRIMARY KEY NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  lane          TEXT NOT NULL,
  department    TEXT,
  url           TEXT,
  contact_email TEXT,
  notes         TEXT,
  -- NULL means "not confirmed". NOTHING may default these, and in particular a
  -- deadline must never be inferred from the event's start date: The Big E's
  -- photography entries closed in June for a September fair, Topsfield's close
  -- five days before theirs. There is no rule to infer from.
  opens_at      INTEGER,
  closes_at     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_applications_event ON event_applications(event_id);
CREATE INDEX IF NOT EXISTS idx_event_applications_lane  ON event_applications(lane);

-- At most ONE whole-lane row per event. Department rows are unconstrained,
-- because a fair legitimately has many (Topsfield lists five with different
-- deadlines).
--
-- Partial, and keyed on `department IS NULL` specifically: SQLite treats NULLs
-- as DISTINCT in a unique index, so a plain UNIQUE(event_id, lane, department)
-- would permit unlimited duplicate whole-lane rows — the exact hole it looks
-- like it is closing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_applications_one_per_lane
  ON event_applications(event_id, lane)
  WHERE department IS NULL;

-- ── Backfill: the 105 commercial-vendor routes ────────────────────────────
--
-- Web routes. Excludes the four junk values cleaned below.
INSERT INTO event_applications (id, event_id, lane, url, notes, closes_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) ||
  '-' || lower(hex(randomblob(6))),
  e.id,
  'commercial_vendor',
  e.application_url,
  NULLIF(TRIM(COALESCE(e.application_instructions, '')), ''),
  e.application_deadline,
  unixepoch(),
  unixepoch()
FROM events e
WHERE e.application_url IS NOT NULL
  AND TRIM(e.application_url) <> ''
  AND e.merged_into IS NULL
  AND e.application_url LIKE 'http%'
  -- Excluded by EXACT value and full prefix, matching the cleanup UPDATEs at the
  -- bottom of this file. A substring test ('%example.com%') over-matches: a real
  -- page at `myfair.org/vendors?ref=example.compare` contains it and would be
  -- silently dropped from the backfill while the cleanup correctly left it
  -- alone. Caught by the "does NOT clear a legitimate URL that merely mentions
  -- the domain" test, which is why that test exists.
  AND e.application_url <> 'https://example.com/application'
  AND e.application_url NOT LIKE 'https://click.mlsend.com/link/c/%';

-- The two `mailto:` routes. These are NOT junk: both events are APPROVED and
-- their application route genuinely IS an email address. Storing them as a URL
-- would be a lie about what they are; dropping them would discard a working
-- route for two live events. They migrate into `contact_email` with `url` NULL.
INSERT INTO event_applications (id, event_id, lane, contact_email, notes, closes_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) ||
  '-' || lower(hex(randomblob(6))),
  e.id,
  'commercial_vendor',
  substr(e.application_url, 8),          -- strip 'mailto:'
  NULLIF(TRIM(COALESCE(e.application_instructions, '')), ''),
  e.application_deadline,
  unixepoch(),
  unixepoch()
FROM events e
WHERE e.application_url LIKE 'mailto:%'
  AND e.merged_into IS NULL
  AND length(TRIM(substr(e.application_url, 8))) > 0;

-- ── Clean the two values that are not application routes at all ───────────
--
-- Scoped by EXACT value, not by pattern, so this cannot over-match a legitimate
-- URL that happens to contain the substring.
--
--   `https://example.com/application` — a placeholder live in production data.
--     Its event is REJECTED, so nothing public changes.
--   `https://click.mlsend.com/link/...` — a MailerLite click-tracking redirect,
--     opaque and expiring. Its event is PENDING (a 2027 show), so nothing public
--     changes.
--
-- Neither is carried into event_applications above.
UPDATE events SET application_url = NULL
WHERE application_url = 'https://example.com/application';

UPDATE events SET application_url = NULL
WHERE application_url LIKE 'https://click.mlsend.com/link/c/%';
