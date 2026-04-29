-- URL domain classifications — gates which outbound URLs are legitimate as
-- ticket destinations, application destinations, or sources to ingest from.
--
-- Background: ~33% of populated events.ticket_url values pointed to competitor
-- aggregator sites (primarily fairsandfestivals.net). The ingestion pipeline
-- was copying source aggregator detail pages into ticket_url. This table is
-- the system of record for which domains are legitimate for which contexts;
-- the ingestion gate (src/lib/url-classification.ts) consults it on every write.
--
-- Three independent flags handle the asymmetry between contexts: Eventbrite is
-- a fine ticket destination but not a source-of-truth for bulk ingestion;
-- fairsandfestivals.net is the inverse.
--
-- Fail-open: unknown domains pass through. The discovery panel (Site Health
-- tab) closes the loop by surfacing high-traffic unclassified destinations.

CREATE TABLE IF NOT EXISTS url_domain_classifications (
  id TEXT PRIMARY KEY,
  -- Normalized: lowercase, no protocol, no www., no trailing slash, no path.
  domain TEXT NOT NULL UNIQUE,
  -- Informational only — used by the admin UI for grouping.
  -- 'aggregator' | 'promoter' | 'ticketing' | 'social' | 'other'.
  domain_type TEXT NOT NULL,
  use_as_ticket_url INTEGER NOT NULL DEFAULT 0,
  use_as_application_url INTEGER NOT NULL DEFAULT 0,
  use_as_source INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- Unix epoch seconds, matches health_issues / indexnow_submissions convention.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- userId of the admin who classified it; 'seed' for the initial migration set.
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_udc_domain_type
  ON url_domain_classifications(domain_type);

-- Starter classifications. Hand-picked from the cleanup of the top 30
-- contaminated rows + the spec author's audit notes. udc-XXX ids are stable
-- and human-readable for debugging "why did this row classify X way?".
-- Admin-added rows after launch will use crypto.randomUUID() (schema default).

INSERT INTO url_domain_classifications
  (id, domain, domain_type, use_as_ticket_url, use_as_application_url, use_as_source, notes, created_at, updated_at, created_by)
VALUES
  -- Aggregators (block as ticket_url + application_url; selectively as source)
  ('udc-001', 'fairsandfestivals.net',  'aggregator', 0, 0, 1, 'Primary contamination source — 33% of populated ticket URLs were here. OK to ingest from but never link to.', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-002', 'festivalnet.com',        'aggregator', 0, 0, 0, '~98% stale data per Apr 2026 audit; not worth ingesting.', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-003', 'thecraftmap.com',        'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-004', 'allevents.in',           'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-005', 'eventcrazy.com',         'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-006', 'eventseeker.com',        'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-007', 'eventful.com',           'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-008', '10times.com',            'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-009', 'mainefairs.net',         'aggregator', 0, 0, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-010', 'mainemade.com',          'aggregator', 0, 0, 1, 'Discovery source for ME events but not a ticket destination.', strftime('%s','now'), strftime('%s','now'), 'seed'),

  -- Promoters (legitimate ticket destinations)
  ('udc-020', 'joycescraftshows.com',           'promoter', 1, 1, 1, 'NH craft show operator', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-021', 'newenglandcraftfairs.com',       'promoter', 1, 1, 1, '50+ year ME-focused operator', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-022', 'gnecraftartisanshows.com',       'promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-023', 'castleberryfairs.com',           'promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-024', 'myneevent.com',                  'promoter', 1, 1, 1, 'New England Premier Events', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-025', 'gurleyantiqueshows.com',         'promoter', 1, 1, 1, 'Bath ME antique sales', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-026', 'craftah.com',                    'promoter', 1, 1, 1, 'Bangor-area craft fair promoter', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-027', 'brattleboroareafarmersmarket.com','promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-028', 'burlingtonfarmersmarket.org',    'promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-029', 'vtfarmersmarket.org',            'promoter', 1, 1, 1, 'Rutland VFFC market', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-030', 'capitalcityfarmersmarket.com',   'promoter', 1, 1, 1, 'Montpelier VT', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-031', 'bangorfarmersmarket.org',        'promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-032', 'berwickwinterfarmersmarket.com', 'promoter', 1, 1, 1, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-033', 'islandartsassociation.com',      'promoter', 1, 1, 1, 'Bar Harbor area', strftime('%s','now'), strftime('%s','now'), 'seed'),

  -- Ticketing platforms
  ('udc-040', 'eventbrite.com',     'ticketing', 1, 1, 0, 'Legit ticket destination; do not bulk-ingest events from here.', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-041', 'ticketmaster.com',   'ticketing', 1, 1, 0, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-042', 'showclix.com',       'ticketing', 1, 1, 0, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-043', 'zapplication.org',   'ticketing', 0, 1, 0, 'Application platform; not a ticket purchase URL', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-044', 'entrythingy.com',    'ticketing', 0, 1, 0, NULL, strftime('%s','now'), strftime('%s','now'), 'seed'),

  -- Social (acceptable fallback)
  ('udc-050', 'facebook.com',       'social', 1, 0, 0, 'OK as ticket fallback when promoter has only FB presence', strftime('%s','now'), strftime('%s','now'), 'seed'),
  ('udc-051', 'instagram.com',      'social', 1, 0, 0, NULL, strftime('%s','now'), strftime('%s','now'), 'seed');
