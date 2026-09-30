/**
 * OPE-643 / OPE-831 — the browse-facet state vocabulary, and the ONE predicate
 * that decides whether a state code reaches a browse page.
 *
 * Extracted from `directory.ts` so a CLIENT component can import it. That file
 * imports the Drizzle schema, so any client importing it drags the whole schema
 * into the browser bundle; this module has no imports at all.
 *
 * Why extracted rather than copied: `groupByState` drops an entry whose code
 * fails this test, and the vendor profile form warns the vendor about exactly
 * that outcome. A second copy of the rule would let the warning and the
 * behaviour drift apart silently — the "one of two parallel paths" defect
 * `directory.ts` already warns about for the vendor/venue split.
 *
 * `directory.ts` re-exports both symbols, so every existing importer is
 * untouched.
 */

/** Full US state/territory names for readable index + page labels (SEO). */
export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "Washington, D.C.",
  PR: "Puerto Rico",
};

/**
 * Is this a code the by-state browse facet is actually about?
 *
 * OPE-643 — the rule, written down: **the facet's vocabulary is
 * `US_STATE_NAMES`, exactly.** It has no opinion about what may be STORED in
 * `state`; it only decides what gets a "By state" page.
 *
 * That distinction is the whole ticket. The three rows this excludes are not
 * dirty data — they are accurate:
 *
 *   Axopar Boats Oy    Helsinki   FINLAND    (a genuinely Finnish company)
 *   Rossiter Boats     Markdale   ON         (Ontario)
 *   Allanson Inc       Markham    ON         (Ontario)
 *
 * So "correct the rows" would have destroyed true information. The column is
 * being used as a region field for non-US businesses, and the defect is that a
 * facet built on US state names enumerated it anyway: `stateLabel` falls back
 * to `code.toUpperCase()`, which is how "finland" rendered as "FINLAND" and
 * "on" as "ON" — a heading claiming Ontario is a state.
 *
 * Worse than a bad page: `/vendors/browse/state/finland` 404s (the detail
 * route requires /^[A-Z]{2}$/), while `/vendors/browse` still LINKED to it. A
 * crawlable hub emitting a link to a 404 is a worse signal than a thin page.
 *
 * Excluded vendors are NOT orphaned — `groupByInitial` has no state filter, so
 * all three remain reachable at `/vendors/browse/letter/<x>`, which preserves
 * OPE-40's "every entity within ~3 clicks" guarantee that this whole subtree
 * exists to provide.
 *
 * To add Canadian provinces later, extend the vocabulary and rename the
 * heading — a deliberate product change, not a loosened filter.
 */
export function isBrowseStateCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return Object.prototype.hasOwnProperty.call(US_STATE_NAMES, code.trim().toUpperCase());
}
