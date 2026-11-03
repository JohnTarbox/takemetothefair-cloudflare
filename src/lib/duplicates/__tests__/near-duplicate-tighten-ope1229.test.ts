/**
 * OPE-1229 — the near-duplicate sweep's first 8 flags (2026-09-29) were 1 true
 * duplicate and 7 distinct events from same-venue calendars. Pinned verbatim
 * from prod: the 7 must flag 0, the true pair must still flag, and OPE-1201's
 * fixtures (near-duplicate-sweep.test.ts) are unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  nearDuplicateReason,
  planNearDuplicateFlags,
  type SweepEventRow,
} from "../near-duplicate-sweep";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
let seq = 0;
function row(
  venue: [string, string, string],
  name: string,
  start: string,
  end?: string
): SweepEventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    name,
    venueId: venue[0],
    venueName: venue[1],
    venueCity: venue[2],
    seriesId: null,
    promoterId: null,
    startDate: at(start),
    endDate: at(end ?? start),
    createdAt: new Date(seq * 1000),
    possibleDuplicateOf: null,
  };
}

const ARMORY: [string, string, string] = ["v-armory", "Augusta Armory", "Augusta"];
const ELKS: [string, string, string] = ["v-elks", "Bangor Elks BPOE #244", "Bangor"];
const ESE: [string, string, string] = ["v-ese", "Eastern States Exposition", "West Springfield"];
const TANGER: [string, string, string] = ["v-tanger", "Tanger Outlets Tilton", "Tilton"];
const PVD: [string, string, string] = ["v-pvd", "WaterFire Arts Center", "Providence"];
const LACONIA: [string, string, string] = ["v-lac", "Downtown Laconia", "Laconia"];
const SALEM: [string, string, string] = ["v-salem", "Salem Common", "Salem"];

// One row, used in two pairs — two copies would themselves be a real duplicate.
const PVD_SBS = row(PVD, "PVD Artisans Small Business Saturday 2026", "2026-11-28");

const FALSE_POSITIVES: Array<[SweepEventRow, SweepEventRow, string]> = [
  [
    row(SALEM, "Salem Haunted Happenings Grand Parade 2026", "2026-10-01"),
    row(SALEM, "Salem Haunted Happenings 2026", "2026-10-01", "2026-10-31"),
    "a sub-event inside its parent's range",
  ],
  [
    row(ESE, "Fiber Festival of New England 2026", "2026-11-07", "2026-11-08"),
    row(ESE, "Old Deerfield Craft Fairs - Holiday Sampler", "2026-11-07", "2026-11-08"),
    "same weekend, different buildings, no shared word",
  ],
  [
    row(
      ARMORY,
      "Augusta Last Minute Christmas Arts and Craft Fair 2026",
      "2026-12-12",
      "2026-12-13"
    ),
    row(ARMORY, "Last Minute Arts & Craft Show Finale 2026", "2026-12-19", "2026-12-20"),
    "Christmas vs Finale",
  ],
  [
    PVD_SBS,
    row(PVD, "PVD Artisans Holiday Premiere 2026", "2026-11-15"),
    "Small Business Saturday vs Premiere",
  ],
  [
    row(PVD, "PVD Artisans Holiday Show 2026", "2026-12-12", "2026-12-13"),
    PVD_SBS,
    "Holiday Show vs Small Business Saturday",
  ],
  [
    row(LACONIA, "Night Before Pumpkin Festival — Laconia 2026", "2026-10-17"),
    row(LACONIA, "Laconia Pumpkin Festival 2026", "2026-10-23", "2026-10-24"),
    "the night-before event vs the festival",
  ],
  [
    row(ELKS, "Bangor Elks Lodge Christmas Craft Fair", "2026-12-12"),
    row(ELKS, "Bangor Elks Lodge Thanksgiving Craft Fair", "2026-11-28"),
    "Thanksgiving vs Christmas",
  ],
];

describe("OPE-1229 — the 7 false positives flag 0", () => {
  it.each(FALSE_POSITIVES)("%#: %s", (a, b) => {
    expect(nearDuplicateReason(a, b)).toBeNull();
  });
  it("as a plan over all 13 rows: nothing", () => {
    expect(
      planNearDuplicateFlags(
        FALSE_POSITIVES.flatMap(([a, b]) => [a, b]),
        new Set()
      )
    ).toEqual([]);
  });
});

describe("OPE-1229 — the true duplicate still flags", () => {
  it("Lakes Region Fall Craft Fair = Falling Leaves Craft Fair at Tanger (identical dates)", () => {
    const a = row(TANGER, "Falling Leaves Craft Fair at Tanger", "2026-09-19", "2026-09-20");
    const b = row(TANGER, "Lakes Region Fall Craft Fair", "2026-09-19", "2026-09-20");
    expect(nearDuplicateReason(a, b)?.reason).toBe("same_venue_same_day");
  });
  it("an occasion word does not stop a same-weekend pair (only disjoint ranges are let off)", () => {
    const a = row(ARMORY, "Christmas Craft Fair", "2026-12-12", "2026-12-13");
    const b = row(ARMORY, "Augusta Holiday Craft Fair", "2026-12-12", "2026-12-13");
    expect(nearDuplicateReason(a, b)).not.toBeNull();
  });
});
