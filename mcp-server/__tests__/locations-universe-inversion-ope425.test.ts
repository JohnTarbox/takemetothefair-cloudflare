/**
 * OPE-425 findings 8 + 9 — prove the oracle can go RED.
 *
 * John's ruling, 2026-08-20, and it is the deliverable rather than the null:
 *
 *   "Right now it has never returned a failure on any input, including an
 *    entirely empty table — so there is no evidence it would catch a *partial*
 *    load, which is precisely what happened last time (2,390 in, 1,967 stored,
 *    no error). Ship the guard clause and the inversion test together; the test
 *    is what closes this."
 *
 * The mechanism, read from the source: every assertion was written as
 * `!loaded || <check>`. With zero rows that short-circuits to `true`, so the
 * report said `rows_match: true`, every state `ok: true`, `problems: []`. Green,
 * on nothing.
 *
 * These tests are the inversion. They exist to fail if the oracle ever becomes
 * unfalsifiable again, which is the actual risk on a table whose known failure
 * mode is a SILENT partial write.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import {
  loadLocationsUniverse,
  EXPECTED_MUNICIPALITIES,
  EXPECTED_TOTAL_ROWS,
  EXPECTED_COUNTY_UNASSIGNED,
} from "../src/locations-universe.js";

// `venues` comes from setup-db; only `locations` needs creating here.
const SCHEMA = `
  CREATE TABLE locations (
    id TEXT PRIMARY KEY, state TEXT, county TEXT, name TEXT, type TEXT,
    parent_location_id TEXT, population INTEGER, population_year INTEGER,
    latitude REAL, longitude REAL, canonical_slug TEXT,
    is_denominator_eligible INTEGER DEFAULT 1
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let raw: any;

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw;
  raw.exec(SCHEMA);
});

/** Seed `n` municipalities for a state, plus the CT CDPs that carry no county. */
function seedFullUniverse(shortfall: Record<string, number> = {}) {
  let i = 0;
  for (const [state, expected] of Object.entries(EXPECTED_MUNICIPALITIES)) {
    const n = expected - (shortfall[state] ?? 0);
    for (let k = 0; k < n; k++) {
      raw
        .prepare(
          "INSERT INTO locations (id,state,county,name,type,canonical_slug,is_denominator_eligible) VALUES (?,?,?,?,?,?,1)"
        )
        .run(`l${i}`, state, "Some County", `Town ${i}`, "town", `town-${i}`);
      i++;
    }
  }
  // The 185 county-unassignable CT CDPs, and enough village/CDP + unorganized
  // rows to reach the expected total. Their exact split does not matter here —
  // only the totals the oracle asserts on.
  const municipalTotal = i;
  for (let k = 0; k < EXPECTED_COUNTY_UNASSIGNED; k++) {
    raw
      .prepare(
        "INSERT INTO locations (id,state,county,name,type,canonical_slug,is_denominator_eligible) VALUES (?,?,NULL,?,?,?,0)"
      )
      .run(`c${k}`, "CT", `CDP ${k}`, "village_cdp", `cdp-${k}`);
  }
  const remaining = EXPECTED_TOTAL_ROWS - municipalTotal - EXPECTED_COUNTY_UNASSIGNED;
  for (let k = 0; k < remaining; k++) {
    raw
      .prepare(
        "INSERT INTO locations (id,state,county,name,type,canonical_slug,is_denominator_eligible) VALUES (?,?,?,?,?,?,0)"
      )
      .run(`v${k}`, "ME", "Some County", `Village ${k}`, "village_cdp", `village-${k}`);
  }
}

describe("locations_universe — the empty case must not read as a pass", () => {
  it("returns ok:null, not ok:true, when nothing is loaded", async () => {
    const u = await loadLocationsUniverse(db);
    expect(u.loaded).toBe(false);
    // The finding-8 assertion. `true` here is the defect.
    expect(u.ok).toBeNull();
    expect(u.status).toBe("not-loaded");
    expect(u.rows_match).toBeNull();
    for (const s of u.by_state) expect(s.ok).toBeNull();
  });

  it("does not claim a green light by leaving problems empty", async () => {
    // `problems: []` alone was readable as "all clear". Paired with a null
    // verdict it can no longer be.
    const u = await loadLocationsUniverse(db);
    expect(u.problems).toEqual([]);
    expect(u.ok).not.toBe(true);
  });
});

describe("locations_universe — INVERSION: a partial load must go red", () => {
  it("goes ok:false on the exact 2,390-in / 1,967-stored shape", async () => {
    // 423 rows short — the silent INSERT OR REPLACE loss that started this.
    seedFullUniverse();
    raw.prepare("DELETE FROM locations WHERE id IN (SELECT id FROM locations LIMIT 423)").run();

    const u = await loadLocationsUniverse(db);
    expect(u.loaded).toBe(true);
    expect(u.ok).toBe(false);
    expect(u.status).toBe("problems");
    expect(u.rows_match).toBe(false);
    expect(u.rows_stored).toBe(EXPECTED_TOTAL_ROWS - 423);
    expect(u.problems.join(" ")).toMatch(/rows_stored/);
  });

  it("names the state when one state's municipalities are short", async () => {
    seedFullUniverse({ ME: 40 });
    const u = await loadLocationsUniverse(db);

    expect(u.ok).toBe(false);
    expect(u.by_state.find((s) => s.state === "ME")?.ok).toBe(false);
    // Untouched states must not be blamed.
    expect(u.by_state.find((s) => s.state === "RI")?.ok).toBe(true);
    expect(u.problems.join(" ")).toMatch(/ME: \d+ municipalities stored/);
  });

  it("goes red when the county-unassigned count drifts in EITHER direction", async () => {
    seedFullUniverse();
    raw.prepare("UPDATE locations SET county = 'Backfilled' WHERE id = 'c0'").run();

    const u = await loadLocationsUniverse(db);
    expect(u.ok).toBe(false);
    expect(u.problems.join(" ")).toMatch(/county unassigned/);
  });

  it("goes GREEN on a complete load — the oracle is not simply always red", async () => {
    // Without this the tests above prove nothing: a check that always fails is
    // as useless as one that always passes.
    seedFullUniverse();
    const u = await loadLocationsUniverse(db);

    expect(u.ok).toBe(true);
    expect(u.status).toBe("ok");
    expect(u.rows_match).toBe(true);
    expect(u.problems).toEqual([]);
  });
});

describe("locations_universe — finding 9: coordinate matches carry their distance", () => {
  it("is null before any coordinate match exists, never zero", async () => {
    seedFullUniverse();
    const u = await loadLocationsUniverse(db);
    // 0 would read as "matches, all perfect". Null is "no such matches".
    expect(u.coordinate_match_km).toBeNull();
  });

  it("separates a 200 m match from a 22 km guess", async () => {
    seedFullUniverse();
    for (const [id, km] of [
      ["v1", 0.2],
      ["v2", 1.4],
      ["v3", 22.0],
    ] as const) {
      raw
        .prepare(
          "INSERT INTO venues (id,name,slug,state,city,location_id,location_matched_by,location_match_km) VALUES (?,?,?,?,?,?,'coordinates',?)"
        )
        .run(id, `Venue ${id}`, `venue-${id}`, "ME", "Somewhere", "l0", km);
    }

    const u = await loadLocationsUniverse(db);
    expect(u.coordinate_match_km).not.toBeNull();
    expect(u.coordinate_match_km!.n).toBe(3);
    expect(u.coordinate_match_km!.p50_km).toBe(1.4);
    expect(u.coordinate_match_km!.max_km).toBe(22);
    // The number worth acting on.
    expect(u.coordinate_match_km!.over_10km).toBe(1);
  });

  it("ignores name-matched venues, which have no distance", async () => {
    seedFullUniverse();
    raw
      .prepare(
        "INSERT INTO venues (id,name,slug,state,city,location_id,location_matched_by) VALUES ('v9','V9','v-9','ME','Bangor','l0','exact')"
      )
      .run();

    const u = await loadLocationsUniverse(db);
    expect(u.coordinate_match_km).toBeNull();
    expect(u.venues_by_matched_by.exact).toBe(1);
  });
});
