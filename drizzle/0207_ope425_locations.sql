-- OPE-425 — canonical New England locations.
--
-- Four open problems share this one missing table: region facets (OPE-393 /
-- OPE-395) have no city→region map, coverage grading (OPE-415) has no
-- denominator, `venues.city` cleanup (OPE-421) has nothing to join against, and
-- the market-player register (OPE-414) wants geography per player.
--
-- Seeded from Census (2023 Gazetteer county-subdivisions + places, 2024
-- sub-county population estimates) by `scripts/build-locations-seed.mjs`, whose
-- output `data/ne-locations.tsv` is committed and reviewable. The script
-- refuses to write a seed whose per-state municipality counts do not reconcile
-- against published totals — a partial locations list fails SILENTLY, which is
-- the failure this ticket exists to prevent.

CREATE TABLE IF NOT EXISTS locations (
  -- Census GEOID. A real external key, so a re-seed updates rather than
  -- duplicates, and a row is traceable back to its source record.
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  county TEXT,
  name TEXT NOT NULL,
  -- city | town | plantation | unorganized_territory | village_cdp
  type TEXT NOT NULL,
  -- Set for villages/CDPs that belong to a municipality. Left NULL by the
  -- seed: the Census gazetteer carries no CDP→MCD containment, and inventing a
  -- parent is precisely the plausible-but-unsourced value this project keeps
  -- getting bitten by. Parents are attached deliberately, one at a time.
  parent_location_id TEXT REFERENCES locations(id),
  population INTEGER,
  -- Stored beside every figure so vintages are never silently mixed.
  population_year INTEGER,
  latitude REAL,
  longitude REAL,
  canonical_slug TEXT NOT NULL,
  source TEXT NOT NULL,
  last_verified_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_locations_state_name ON locations(state, name);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_location_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_slug ON locations(canonical_slug);

-- Every other way a place gets written down.
--
-- This is what makes the table joinable against data we already hold: our venue
-- rows use village and postal names heavily (Oquossoc, Northeast Harbor, South
-- Paris), and a municipality-only list does not match them. It is also where
-- "L/A", "MDI", "The County" and outright misspellings live.
CREATE TABLE IF NOT EXISTS location_aliases (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  state TEXT NOT NULL,
  -- village | historic | abbreviation | misspelling | postal
  alias_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One spelling resolves to one place per state. The state qualifier matters:
-- Portland is a city in ME and a town in CT, Richmond is a town in ME and RI.
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_aliases_unique
  ON location_aliases(state, alias);
CREATE INDEX IF NOT EXISTS idx_location_aliases_location ON location_aliases(location_id);

-- Region membership, MANY-to-many on purpose.
--
-- Regions overlap and are contested — is Brunswick Midcoast or Greater
-- Portland? — so a scalar `region` column would be wrong the day it shipped.
-- `is_primary` gives a facet page a default without forcing a false exclusive
-- choice.
--
-- ⚠️ Seeded EMPTY. Region boundaries are John's call and the useful ones
-- (Midcoast, Downeast, The County, Lakes Region) do not follow county lines, so
-- deriving them from counties would encode a wrong answer that later looks
-- authoritative.
CREATE TABLE IF NOT EXISTS location_regions (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  region_slug TEXT NOT NULL,
  region_label TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_location_regions_unique
  ON location_regions(location_id, region_slug);
CREATE INDEX IF NOT EXISTS idx_location_regions_slug ON location_regions(region_slug);

-- ZIPs get their own child table: one town has several, and Waterville and
-- Winslow share 04901, so neither direction is a scalar.
CREATE TABLE IF NOT EXISTS location_zips (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  zip TEXT NOT NULL,
  PRIMARY KEY (location_id, zip)
);

CREATE INDEX IF NOT EXISTS idx_location_zips_zip ON location_zips(zip);

-- The join that makes all of the above reach our actual data. Nullable, and
-- backfilled by alias match — the rows that do NOT resolve are the report that
-- feeds OPE-421 (`venues.city` holding venue names).
ALTER TABLE venues ADD COLUMN location_id TEXT REFERENCES locations(id);

CREATE INDEX IF NOT EXISTS idx_venues_location ON venues(location_id);
