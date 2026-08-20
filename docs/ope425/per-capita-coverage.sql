-- OPE-425 — the canonical coverage query, by TOWN and by COUNTY.
--
-- Shipped as an artifact because the acceptance criterion is "a single query
-- yields events-per-capita and coverage-vs-universe by town, county and
-- region". The capability existing is not the same as the query existing, and
-- the review was right to say so: "enabled" is not "correct".
--
-- ⚠️ THE DENOMINATOR RULE — the reason this file exists rather than a note.
--
-- A CDP's population is a SUBSET of its parent municipality's. Barnstable the
-- town contains Hyannis the CDP, and both carry a population. Any
-- SUM(population) over all of `locations` therefore DOUBLE-COUNTS, and every
-- coverage ratio computed from it is inflated by the 791 non-municipal rows.
--
-- `is_denominator_eligible` (0 for village_cdp) is the guard. Every denominator
-- below filters on it. Do not remove that predicate to "include more places" —
-- it does not include more places, it counts some of them twice.
--
-- Rolling ±12 months on BOTH bounds, never forward-from-today: a forward-only
-- window noindexes peak-season markets in August. See OPE-395 / OPE-470.

-- ── 1. By town ────────────────────────────────────────────────────────────
SELECT
  l.state,
  l.county,
  l.name                                   AS town,
  l.population,
  l.population_year,
  COUNT(DISTINCT e.id)                     AS events_rolling_12,
  ROUND(COUNT(DISTINCT e.id) * 10000.0 / NULLIF(l.population, 0), 1)
                                           AS events_per_10k
FROM locations l
LEFT JOIN venues v ON v.location_id = l.id
LEFT JOIN events e
       ON e.venue_id = v.id
      AND e.status = 'APPROVED'
      AND e.merged_into IS NULL
      AND e.start_date >= unixepoch('now', '-12 months')
      AND e.start_date <  unixepoch('now', '+12 months')
WHERE l.is_denominator_eligible = 1          -- ← the rule. See the header.
GROUP BY l.id
ORDER BY events_per_10k DESC NULLS LAST;

-- ── 2. By county ──────────────────────────────────────────────────────────
-- `county_vintage` is carried through deliberately: Connecticut's county
-- equivalents changed in 2024 (nine planning regions replacing eight legacy
-- counties), so a county-grain number without its vintage is not reproducible.
SELECT
  l.state,
  l.county,
  MIN(l.county_vintage)                    AS county_vintage,
  COUNT(*)                                 AS towns_in_universe,
  SUM(l.population)                        AS population,
  COUNT(DISTINCT CASE WHEN e.id IS NOT NULL THEN l.id END)
                                           AS towns_with_events,
  ROUND(COUNT(DISTINCT CASE WHEN e.id IS NOT NULL THEN l.id END) * 100.0
        / NULLIF(COUNT(*), 0), 1)          AS coverage_pct,
  COUNT(DISTINCT e.id)                     AS events_rolling_12,
  ROUND(COUNT(DISTINCT e.id) * 10000.0 / NULLIF(SUM(l.population), 0), 1)
                                           AS events_per_10k
FROM locations l
LEFT JOIN venues v ON v.location_id = l.id
LEFT JOIN events e
       ON e.venue_id = v.id
      AND e.status = 'APPROVED'
      AND e.merged_into IS NULL
      AND e.start_date >= unixepoch('now', '-12 months')
      AND e.start_date <  unixepoch('now', '+12 months')
WHERE l.is_denominator_eligible = 1
  AND l.county IS NOT NULL AND l.county <> ''
GROUP BY l.state, l.county
ORDER BY coverage_pct ASC;                  -- worst-covered markets first

-- ── 3. The join-health check that belongs beside them ─────────────────────
-- Both queries above are only as good as `venues.location_id`. A venue that
-- never resolved contributes zero events to its town and is invisible in the
-- numerator while its town still sits in the denominator — an undercount that
-- looks exactly like a coverage gap. `location_matched_by` separates the two.
SELECT
  COALESCE(location_matched_by, 'unmatched') AS matched_by,
  COUNT(*)                                   AS venues,
  SUM(CASE WHEN latitude IS NOT NULL THEN 1 ELSE 0 END) AS with_coordinates
FROM venues
GROUP BY 1
ORDER BY venues DESC;
