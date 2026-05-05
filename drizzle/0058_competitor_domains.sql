-- 0058: §10.2 move hardcoded competitor list into D1.
--
-- The competitor_url_contamination rule loaded its domain list from a
-- hardcoded array in src/lib/recommendations/rules/competitor-url-contamination.ts.
-- Moving to a curated D1 table so admins can add/remove competitors without
-- a code deploy. Seeded with the prior hardcoded entries.

CREATE TABLE competitor_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX idx_competitor_domains_domain ON competitor_domains(domain);

INSERT INTO competitor_domains (id, domain, notes, created_at) VALUES
  ('seed-fnf-net', 'fairsandfestivals.net',
   'Aggregator/competitor — seeded from hardcoded list in §10.2 PR.', unixepoch()),
  ('seed-festivalnet', 'festivalnet.com',
   'Aggregator/competitor — seeded from hardcoded list in §10.2 PR.', unixepoch()),
  ('seed-fnf-com', 'fairsandfestivals.com',
   'Aggregator/competitor — seeded from hardcoded list in §10.2 PR.', unixepoch()),
  ('seed-craftshow', 'craftshowyellowpages.com',
   'Aggregator/competitor — seeded from hardcoded list in §10.2 PR.', unixepoch());
