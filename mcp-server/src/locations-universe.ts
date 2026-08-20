/**
 * OPE-425 review findings 6 + 7 — make the locations seed checkable AFTER it runs.
 *
 * Two things the first delivery could not answer from any read surface:
 *
 *  6. "Is `rows_in == rows_stored` asserted where the WRITE happens?" The
 *     sharpest catch in that delivery was 2,390 rows in, 1,967 stored, no error
 *     — `INSERT OR REPLACE` against a UNIQUE(canonical_slug) silently deleting
 *     an unrelated row to make space. It was caught by a one-off local
 *     end-to-end test, which means the next seed refresh reproduces it silently.
 *
 *  7. There was no MCP read path for `locations` at all, so every number about
 *     the newest table in the project was a local measurement nobody else could
 *     reproduce.
 *
 * A continuous check answers both, and answers 6 more strongly than a one-shot
 * assertion would: this compares stored reality against externally-sourced
 * targets on every run of the data-health report, so a refresh that loses rows
 * shows up the same day rather than at the next audit.
 *
 * The targets live in code and come from OUTSIDE the extraction — see the long
 * citation block in scripts/build-locations-seed.mjs. Reading them off our own
 * output is what made an earlier version of this guard circular.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

/** Published municipality counts. Sources cited in build-locations-seed.mjs. */
export const EXPECTED_MUNICIPALITIES: Record<string, number> = {
  CT: 169,
  ME: 484,
  MA: 351,
  NH: 234,
  RI: 39,
  VT: 247,
};

/** Total rows the seed emits: municipalities + village/CDP + unorganized. */
export const EXPECTED_TOTAL_ROWS = 2390;
export const EXPECTED_VILLAGE_CDP = 791;
export const EXPECTED_UNORGANIZED = 75;

/**
 * The 185 CT CDPs that cannot be county-assigned from any published file
 * without mixing county vintages. Expected, documented, and asserted so the
 * number cannot drift unnoticed in either direction.
 */
export const EXPECTED_COUNTY_UNASSIGNED = 185;

export interface LocationsUniverse {
  loaded: boolean;
  rows_stored: number;
  rows_expected: number;
  rows_match: boolean;
  by_state: Array<{
    state: string;
    municipal_stored: number;
    municipal_expected: number;
    ok: boolean;
  }>;
  by_type: Record<string, number>;
  county_unassigned: number;
  county_unassigned_expected: number;
  denominator_eligible: number;
  venues_total: number;
  venues_resolved: number;
  venues_by_matched_by: Record<string, number>;
  /** Venues with neither a usable name nor a usable point — the OPE-421 list. */
  venues_unresolved: Array<{ state: string; city: string; has_coordinates: boolean }>;
  problems: string[];
}

const MUNICIPAL = ["city", "town", "plantation"];

export async function loadLocationsUniverse(db: Db): Promise<LocationsUniverse> {
  const [{ n: rowsStored } = { n: 0 }] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(sql`locations`);

  const problems: string[] = [];
  const loaded = Number(rowsStored) > 0;

  const typeRows = loaded
    ? await db
        .select({ t: sql<string>`type`, n: sql<number>`COUNT(*)` })
        .from(sql`locations`)
        .groupBy(sql`type`)
    : [];
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.t] = Number(r.n);

  const stateRows = loaded
    ? await db
        .select({ s: sql<string>`state`, n: sql<number>`COUNT(*)` })
        .from(sql`locations`)
        .where(sql`type IN ('city','town','plantation')`)
        .groupBy(sql`state`)
    : [];
  const municipalByState = new Map(stateRows.map((r) => [r.s, Number(r.n)]));

  const byState = Object.entries(EXPECTED_MUNICIPALITIES).map(([state, expected]) => {
    const stored = municipalByState.get(state) ?? 0;
    const ok = !loaded || stored === expected;
    if (loaded && !ok) {
      problems.push(`${state}: ${stored} municipalities stored, ${expected} expected`);
    }
    return { state, municipal_stored: stored, municipal_expected: expected, ok };
  });

  const [{ n: countyUnassigned } = { n: 0 }] = loaded
    ? await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(sql`locations`)
        .where(sql`county IS NULL OR county = ''`)
    : [{ n: 0 }];

  const [{ n: denomEligible } = { n: 0 }] = loaded
    ? await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(sql`locations`)
        .where(sql`is_denominator_eligible = 1`)
    : [{ n: 0 }];

  const [{ n: venuesTotal } = { n: 0 }] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(sql`venues`);
  const [{ n: venuesResolved } = { n: 0 }] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(sql`venues`)
    .where(sql`location_id IS NOT NULL`);

  const matchRows = await db
    .select({ m: sql<string>`COALESCE(location_matched_by,'unmatched')`, n: sql<number>`COUNT(*)` })
    .from(sql`venues`)
    .groupBy(sql`COALESCE(location_matched_by,'unmatched')`);
  const byMatchedBy: Record<string, number> = {};
  for (const r of matchRows) byMatchedBy[r.m] = Number(r.n);

  // The OPE-421 report, narrowed to what it was always meant to be: rows we can
  // resolve by NEITHER name NOR point.
  const unresolved = await db
    .select({
      state: sql<string>`state`,
      city: sql<string>`COALESCE(city,'')`,
      hasCoords: sql<number>`CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END`,
    })
    .from(sql`venues`)
    .where(sql`location_id IS NULL AND COALESCE(city,'') <> ''`)
    .limit(50);

  if (loaded && Number(rowsStored) !== EXPECTED_TOTAL_ROWS) {
    problems.push(
      `rows_stored ${rowsStored} != rows_expected ${EXPECTED_TOTAL_ROWS} — ` +
        `this is the 423-row silent-loss shape (INSERT OR REPLACE on a UNIQUE slug)`
    );
  }
  if (loaded && Number(countyUnassigned) !== EXPECTED_COUNTY_UNASSIGNED) {
    problems.push(
      `county unassigned ${countyUnassigned}, expected ${EXPECTED_COUNTY_UNASSIGNED} (the CT CDPs)`
    );
  }

  return {
    loaded,
    rows_stored: Number(rowsStored),
    rows_expected: EXPECTED_TOTAL_ROWS,
    rows_match: !loaded || Number(rowsStored) === EXPECTED_TOTAL_ROWS,
    by_state: byState,
    by_type: byType,
    county_unassigned: Number(countyUnassigned),
    county_unassigned_expected: EXPECTED_COUNTY_UNASSIGNED,
    denominator_eligible: Number(denomEligible),
    venues_total: Number(venuesTotal),
    venues_resolved: Number(venuesResolved),
    venues_by_matched_by: byMatchedBy,
    venues_unresolved: unresolved.map((r) => ({
      state: r.state,
      city: r.city,
      has_coordinates: Number(r.hasCoords) === 1,
    })),
    problems,
  };
}

/** Municipal types, exported so a caller cannot re-spell the list. */
export const MUNICIPAL_TYPES = MUNICIPAL;
