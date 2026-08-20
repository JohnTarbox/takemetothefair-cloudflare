#!/usr/bin/env node
/**
 * OPE-425 — build the canonical New England `locations` seed from Census data.
 *
 * Emits `data/ne-locations.tsv`, which is COMMITTED. The file is the reviewable
 * artifact; this script is how it is regenerated when the Census vintage moves.
 *
 * ── Why this is a script and not a hand-typed list ───────────────────────
 *
 * The ticket is explicit, and it is right: a hand-assembled seed fails
 * SILENTLY. The 92-row CSV that prompted the ticket omitted 51% of the towns
 * where we actually hold events — Wells, Standish, Freeport, Southwest Harbor —
 * and joined as a canonical list it would have dropped 30% of our Maine
 * inventory without erroring once.
 *
 * ── The trap this script exists to not fall into ─────────────────────────
 *
 * In the Census county-subdivision files, New England TOWNS are FUNCSTAT='A'
 * and New England CITIES are FUNCSTAT='F' — "fictitious entity created to fill
 * the geographic hierarchy", because a city's government is recorded at the
 * PLACE level instead. So the obvious filter, `FUNCSTAT = 'A'`, silently drops
 * every city in the region: Portland, Bangor, Lewiston, Auburn, Boston,
 * Providence, Hartford.
 *
 * That is the same class of failure as the hand-typed list, arrived at from the
 * opposite direction, which is why the counts below are asserted rather than
 * trusted. Every state must reconcile against its published municipality total
 * or this script exits non-zero.
 *
 * ── Sources (all keyless; api.census.gov requires a key we do not have) ───
 *
 *   cousubs gazetteer   municipality universe + centroid lat/lon
 *   place gazetteer     CDPs / villages
 *   sub-est population  one vintage, labelled — never mixed
 *
 * Run: node scripts/build-locations-seed.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/ne-locations.tsv");

const GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer";
const SUBEST =
  "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv";

/** Population vintage. Stored alongside every figure so vintages are never
 *  silently mixed — the ticket calls this out explicitly. */
const POPULATION_YEAR = 2024;
const POPULATION_FIELD = "POPESTIMATE2024";

const STATES = { "09": "CT", 23: "ME", 25: "MA", 33: "NH", 44: "RI", 50: "VT" };

/**
 * Published municipality counts, as the reconciliation target.
 *
 * These are the numbers a resident of each state would recognise, and they are
 * the whole point: if the extraction drifts, this is what catches it.
 *
 *   CT 169 towns · MA 351 · RI 39 · NH 234 (221 towns + 13 cities)
 *   VT 247 (237 towns + 10 cities, Essex Junction having incorporated in 2022)
 *   ME 484 (430 towns + 31 plantations + 23 cities)
 *
 * OPE-425 review finding 5 — each target's EXTERNAL source, named. An external
 * target with no external reference is an assertion, not a check:
 *
 *   CT 169  CT Secretary of the State / CCM — "169 towns", the state's own
 *           universally-cited figure. Unaffected by the 2022 county-equivalent
 *           change, which replaced counties, not municipalities.
 *   ME 484  Maine Municipal Association / Maine SoS: 23 cities, 430 towns,
 *           31 plantations. (The 41 unorganized territories are NOT
 *           municipalities and are excluded from this target — see the
 *           residual report below.)
 *   MA 351  Massachusetts Secretary of the Commonwealth — "351 cities and
 *           towns", the standard figure used by every state agency.
 *   NH 234  NH Municipal Association: 13 cities + 221 towns. Excludes the 25
 *           unincorporated places/townships/grants.
 *   RI  39  RI Secretary of State — "39 cities and towns".
 *   VT 247  VT League of Cities & Towns: 237 towns + 10 cities, Essex Junction
 *           having incorporated as a city in 2022. Excludes the 9 gores and
 *           unorganized towns.
 *
 * ⚠️ These must come from OUTSIDE this script. An earlier pass set NH to 235
 * and VT to 252 by reading them off the extraction's own output, which makes
 * the guard circular — it would then have "reconciled" with Livermore (a town
 * NH dissolved in 1951) and Vermont's five unorganized towns counted as live
 * municipalities. FUNCSTAT='I' marks exactly those, and they are now excluded
 * from the count while still being kept in the table.
 */
const EXPECTED_MUNICIPALITIES = { CT: 169, ME: 484, MA: 351, NH: 234, RI: 39, VT: 247 };

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

function parseCsv(text) {
  // sub-est is plain comma-separated with quoted names containing no commas in
  // the fields we read; a full CSV parser would be overkill.
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/** "Auburn city" → { base: "Auburn", kind: "city" }. The Census suffix IS the
 *  legal type, so it is parsed rather than guessed.
 *
 * ⚠️ Massachusetts then does it twice. Seven municipalities are legally named
 * "<X> Town" and are cities, so the Census row reads `Winthrop Town city` —
 * and stripping only the type suffix leaves "Winthrop Town", which never
 * matches a venue that says "Winthrop". Barnstable, Amesbury, Methuen, Agawam,
 * Palmer and North Attleborough are the others.
 *
 * The state count reconciled at 351 with this bug present, because the row was
 * there under a name nobody uses — which is a good reminder that a count check
 * proves presence, not usability. It was caught by matching against real
 * `venues.city` values instead.
 */
function splitName(name) {
  const m = name.match(
    /^(.*?)\s+(city|town|plantation|village|borough|gore|grant|purchase|township|location|Reservation|UT)$/
  );
  if (!m) return { base: name, kind: null, legalName: name };
  const legalName = m[1];
  // "Winthrop Town" → "Winthrop", keeping the legal form for the alias table.
  const base = m[2] === "city" ? legalName.replace(/\s+Town$/, "") : legalName;
  return { base, kind: m[2], legalName };
}

const KIND_TO_TYPE = {
  city: "city",
  town: "town",
  plantation: "plantation",
  UT: "unorganized_territory",
  gore: "unorganized_territory",
  grant: "unorganized_territory",
  purchase: "unorganized_territory",
  township: "unorganized_territory",
  location: "unorganized_territory",
};

/** A municipality is a general-purpose government. Everything else — statistical
 *  unorganized territory, gores, and the "County subdivisions not defined"
 *  filler rows — is kept in the table but excluded from the count. */
const MUNICIPAL_TYPES = new Set(["city", "town", "plantation"]);

/**
 * Slugify a place name.
 *
 * Uses the Unicode property escape rather than `[^a-z0-9]` — which the repo's
 * #120 lint rule bans, correctly: an ASCII-only class mangles the accented
 * names this dataset genuinely contains (Coös County NH is the local one).
 * `createSlug()` from @takemetothefair/utils is the canonical helper, but it is
 * TypeScript in a workspace package and this is a standalone Node script that
 * runs without a build step, so the transform is reproduced here instead.
 */
function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’.]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join("-");
}

async function main() {
  console.log("Fetching Census sources…");
  const subest = parseCsv(await fetchText(SUBEST));

  // County / planning-region names, keyed by state+county FIPS.
  const countyName = new Map();
  for (const r of subest) {
    if (r.SUMLEV === "050" && STATES[r.STATE]) {
      countyName.set(`${r.STATE}${r.COUNTY}`, r.NAME);
    }
  }

  // Population by MCD (SUMLEV 061) and by place (162 incorporated, 157 CDP).
  const popByCousub = new Map();
  const popByPlace = new Map();
  for (const r of subest) {
    if (!STATES[r.STATE]) continue;
    const pop = Number(r[POPULATION_FIELD]);
    if (!Number.isFinite(pop)) continue;
    if (r.SUMLEV === "061") popByCousub.set(`${r.STATE}${r.COUNTY}${r.COUSUB}`, pop);
    else if (r.SUMLEV === "162" || r.SUMLEV === "157")
      popByPlace.set(`${r.STATE}${r.PLACE}`, pop);
  }

  const rows = [];
  const counts = {};

  /**
   * Slugs must be unique, because the load is `INSERT OR REPLACE` keyed on the
   * Census GEOID and the table has a UNIQUE index on `canonical_slug`.
   *
   * A CDP very often carries its parent town's name — Maine has both an
   * "Alfred town" and an "Alfred CDP" — so a naive `<state>-<name>` slug
   * collides, and REPLACE then deletes an unrelated row to make room. Caught by
   * an end-to-end load test: 2,390 rows in, 1,967 rows stored, no error. 423
   * places vanished silently, which is precisely the failure this ticket exists
   * to stop, reproduced inside the fix for it.
   */
  const usedSlugs = new Set();
  const uniqueSlug = (base, type) => {
    let s = base;
    if (usedSlugs.has(s) && type === "village_cdp") s = `${base}-cdp`;
    let i = 2;
    while (usedSlugs.has(s)) s = `${base}-${i++}`;
    usedSlugs.add(s);
    return s;
  };

  for (const [fips, usps] of Object.entries(STATES)) {
    const cousubs = parseTsv(await fetchText(`${GAZ}/2023_gaz_cousubs_${fips}.txt`));
    let municipal = 0;

    for (const r of cousubs) {
      const { base, kind } = splitName(r.NAME);
      // "County subdivisions not defined" — water and unorganized filler that
      // exists only to tile the map. Never a place anyone holds a fair.
      if (/not defined/i.test(r.NAME)) continue;
      // Tribal reservations are real places but are not municipalities and do
      // not behave like one for coverage grading; kept out of v1 rather than
      // mis-typed.
      if (kind === "Reservation") continue;

      // FUNCSTAT='I' — an inactive governmental unit. NH's Livermore, and
      // Vermont's Glastenbury / Averill / Ferdinand / Lewis / Somerset. They
      // are named "town" and have not had a government in decades, so they are
      // kept as rows (a venue could still carry the name) but typed as
      // unorganized territory and left out of the municipality count.
      const type = r.FUNCSTAT === "I" ? "unorganized_territory" : (KIND_TO_TYPE[kind] ?? "town");
      if (MUNICIPAL_TYPES.has(type)) municipal++;

      rows.push({
        geoid: r.GEOID,
        state: usps,
        county: countyName.get(r.GEOID.slice(0, 5)) ?? "",
        county_note: "",
        // OPE-425 review finding 1 — county geography is NOT immutable, and
        // Connecticut proved it inside four years: the Bureau replaced CT's
        // eight legacy counties with NINE PLANNING REGIONS as county
        // equivalents (approved 2022, implemented 2024). The 2023 Gazetteer
        // already carries them, which is why this seed's CT rows read
        // "Capitol Planning Region" and not "Hartford County". Recording the
        // vintage is what stops a future refresh silently mixing the two.
        county_vintage: "census-cousub-2023",
        name: base,
        type,
        parent_geoid: "",
        population: popByCousub.get(r.GEOID) ?? "",
        population_year: popByCousub.has(r.GEOID) ? POPULATION_YEAR : "",
        latitude: r.INTPTLAT,
        longitude: r.INTPTLONG,
        canonical_slug: uniqueSlug(`${usps.toLowerCase()}-${slugify(base)}`, type),
        source: "census-gazetteer-2023-cousubs",
      });
    }

    // CDPs / villages. These are what our venue data actually uses — Oquossoc,
    // Northeast Harbor, South Paris — and without them a canonical list does
    // not join. `parent_geoid` is left EMPTY: the Census gazetteer carries no
    // CDP→MCD containment, and inventing a parent is exactly the kind of
    // plausible-but-unsourced value this project keeps getting bitten by. The
    // alias table is where verified parents are attached, one at a time.
    // Both CDPs and INCORPORATED VILLAGES. Vermont's villages-within-towns —
    // Lyndonville, Enosburg Falls — are real chartered entities that appear in
    // the place file but never in the county-subdivision file, so a CDP-only
    // filter drops them and every venue that names one fails to resolve.
    const places = parseTsv(await fetchText(`${GAZ}/2023_gaz_place_${fips}.txt`));

    // OPE-425 review finding 1 — county for the village/CDP rows.
    //
    // The Gazetteer place file carries no county, which is why 791 CDP rows
    // shipped with `county` blank. The review asked for point-in-polygon
    // against Census county boundaries; the Bureau's OWN place-to-county
    // relationship file is used instead, which is strictly better where it
    // applies — a published assignment cannot disagree with the Bureau at a
    // boundary the way a geometry we compute can.
    //
    // ⚠️ TWO TRAPS, both found by the guard below rather than by reading:
    //
    // 1. PLACE FIPS DRIFT. Brookfield Center CT is 09|08910 in the 2020 codes
    //    file and GEOID 0909050 in the 2023 Gazetteer. Keying the join on GEOID
    //    silently loses rows across vintages, so it keys on normalized NAME +
    //    state, which is stable.
    //
    // 2. CONNECTICUT MUST BE EXCLUDED. Only the 2020 vintage of this file
    //    exists (2023/2024 return 404), and it assigns CT places to the EIGHT
    //    LEGACY COUNTIES — while our CT municipalities carry the NINE PLANNING
    //    REGIONS from the 2023 Gazetteer. Joining it would put "Fairfield
    //    County" next to "Western Connecticut Planning Region" inside one
    //    state, which is precisely the "do not silently mix vintages" rule this
    //    ticket already applies to population. CT's CDPs are therefore left
    //    unassigned and reported as an explicit remainder — the honest answer,
    //    and the one the review asked for when assignment is impossible.
    const placeCounty = new Map();
    if (usps !== "CT") {
      const placeCodes = await fetchText(
        `https://www2.census.gov/geo/docs/reference/codes2020/place/st${fips}_${usps.toLowerCase()}_place2020.txt`
      );
      for (const line of placeCodes.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue;
        const c = line.split("|");
        const rawName = (c[4] ?? "").replace(/\s+(CDP|village|city|town|borough)$/i, "").trim();
        const counties = (c[8] ?? "").trim();
        if (rawName && counties) placeCounty.set(rawName.toLowerCase(), counties);
      }
    }

    for (const p of places) {
      if (!/\s(CDP|village)$/.test(p.NAME)) continue;
      const base = p.NAME.replace(/\s+(CDP|village)$/, "");
      rows.push({
        geoid: p.GEOID,
        state: usps,
        county: (placeCounty.get(base.toLowerCase()) ?? "").split(/\s*,\s*/)[0] ?? "",
        county_note: placeCounty.get(base.toLowerCase()) ?? "",
        county_vintage: placeCounty.has(base.toLowerCase())
          ? "census-place-codes-2020"
          : usps === "CT"
            ? "unassigned-ct-planning-region-vintage-gap"
            : "unassigned-not-in-place-codes-2020",
        name: base,
        type: "village_cdp",
        parent_geoid: "",
        population: popByPlace.get(p.GEOID) ?? "",
        population_year: popByPlace.has(p.GEOID) ? POPULATION_YEAR : "",
        latitude: p.INTPTLAT,
        longitude: p.INTPTLONG,
        canonical_slug: uniqueSlug(`${usps.toLowerCase()}-${slugify(base)}`, "village_cdp"),
        source: "census-gazetteer-2023-place",
      });
    }

    counts[usps] = municipal;
  }

  // ── The reconciliation. This is the guard, not a log line. ─────────────
  console.log("\nMunicipality counts vs published totals:");
  let bad = 0;
  for (const [usps, expected] of Object.entries(EXPECTED_MUNICIPALITIES)) {
    const got = counts[usps] ?? 0;
    const ok = got === expected;
    if (!ok) bad++;
    console.log(`  ${usps}  ${String(got).padStart(4)} / ${expected}  ${ok ? "ok" : "MISMATCH"}`);
  }
  // OPE-425 review finding 4 — the row arithmetic must CLOSE, per type per
  // state. The first delivery reported 2,390 rows against 1,524 municipalities
  // + 791 village/CDP = 2,315, leaving 75 rows the reconciliation guard did not
  // cover — and the reviewer had to infer what they were. They are the
  // unorganized territories (ME 41 + NH 25 + VT 9). Inference by the reviewer is
  // exactly what this guard exists to prevent, so it now prints every bucket.
  const byStateType = {};
  for (const r of rows) {
    byStateType[r.state] ??= {};
    byStateType[r.state][r.type] = (byStateType[r.state][r.type] ?? 0) + 1;
  }
  console.log("\nEvery row, by state and type (the arithmetic must close):");
  let grand = 0;
  for (const usps of Object.values(STATES)) {
    const t = byStateType[usps] ?? {};
    const muni = Object.entries(t)
      .filter(([k]) => MUNICIPAL_TYPES.has(k))
      .reduce((a, [, v]) => a + v, 0);
    const total = Object.values(t).reduce((a, v) => a + v, 0);
    grand += total;
    console.log(
      `  ${usps}  municipal ${String(muni).padStart(4)}  ` +
        Object.entries(t)
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join(" ") +
        `  → ${total}`
    );
  }
  const villages = rows.filter((r) => r.type === "village_cdp").length;
  const uts = rows.filter((r) => r.type === "unorganized_territory").length;
  const municipalAll = rows.filter((r) => MUNICIPAL_TYPES.has(r.type)).length;
  console.log(
    `\n  ${municipalAll} municipal + ${villages} village/CDP + ${uts} unorganized = ${
      municipalAll + villages + uts
    }  (rows: ${rows.length})`
  );
  if (municipalAll + villages + uts !== rows.length || grand !== rows.length) {
    console.error(
      `\nRow arithmetic does not close — ${rows.length} rows but the buckets sum to ` +
        `${municipalAll + villages + uts}. A row in no bucket is a row nobody is checking.`
    );
    process.exit(1);
  }

  // County must be assigned for every row now that the place-codes relationship
  // file supplies it for CDPs. A blank county silently drops the row from every
  // county-grain rollup.
  // Every MUNICIPALITY must carry a county — a blank there silently drops the
  // row from every county-grain rollup, and municipalities are the denominator.
  // CDPs may legitimately lack one (see the CT note above); that remainder is
  // REPORTED, never silent, which is what the review asked for.
  const muniNoCounty = rows.filter((r) => MUNICIPAL_TYPES.has(r.type) && !r.county);
  if (muniNoCounty.length > 0) {
    console.error(`\n${muniNoCounty.length} MUNICIPALITY row(s) have no county — refusing:`);
    for (const r of muniNoCounty.slice(0, 10)) console.error(`  ${r.state} ${r.name} (${r.type})`);
    process.exit(1);
  }
  const noCounty = rows.filter((r) => !r.county);
  const byReason = {};
  for (const r of noCounty) byReason[r.county_vintage] = (byReason[r.county_vintage] ?? 0) + 1;
  console.log(
    `\nCounty assigned: ${rows.length - noCounty.length}/${rows.length}. ` +
      `Unassigned remainder ${noCounty.length}:`
  );
  for (const [reason, n] of Object.entries(byReason)) console.log(`  ${n}  ${reason}`);

  if (bad > 0) {
    console.error(
      `\n${bad} state(s) did not reconcile. Refusing to write a seed nobody can trust —\n` +
        `a partial locations list fails silently, which is the whole reason this\n` +
        `script exists. Investigate before changing the expected counts.`
    );
    process.exit(1);
  }

  const cols = [
    "geoid",
    "state",
    "county",
    "county_note",
    "county_vintage",
    "name",
    "type",
    "parent_geoid",
    "population",
    "population_year",
    "latitude",
    "longitude",
    "canonical_slug",
    "source",
  ];
  const tsv = [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join(
    "\n"
  );
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, tsv + "\n", "utf8");
  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
