/**
 * OPE-1254 — "VCS Holiday Market 2026" was created a month after
 * "Vassalboro Community School Holiday Market" (same school, same 12-05, same
 * hours) and dedup never fired. Neither row had a venue when the second
 * arrived (the venue was created by hand on 09-25), so the venue and
 * city/state stages were blind, and OPE-477's name-containment stage — the one
 * built for exactly that — could not see that "VCS" is the school's initials.
 *
 * Real in-memory SQLite; venue resolution inert, as on 09-22.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { classifyDedupTier } from "@takemetothefair/utils";

vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: vi.fn(async () => ({ venueId: null, decision: "no-match" })),
}));

import { findDuplicate } from "../find-duplicate";
import { nameContainmentMatch } from "../name-containment";
import { normalizeName } from "../normalize-name";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, end_date INTEGER,
    status TEXT, source_url TEXT, venue_id TEXT,
    series_id TEXT, rolled_from_event_id TEXT,
    merged_into TEXT
  );
  CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const epoch = (iso: string) => Math.floor(new Date(`${iso}T12:00:00Z`).getTime() / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  // Row 1 as it stood on 2026-09-22: PENDING, no venue, no source.
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, start_date, status, source_url, venue_id)
       VALUES ('07cdf570', 'vassalboro-community-school-holiday-market', ?, ?, 'PENDING', NULL, NULL)`
    )
    .run("Vassalboro Community School Holiday Market", epoch("2026-12-05"));
});

describe("OPE-1254 — the exact pair", () => {
  it("row 2 as named (no venue resolved) now matches row 1, at MEDIUM → possible_duplicate_of", async () => {
    const res = await findDuplicate(db, {
      sourceUrl: "https://holiday-market-vendor-registration-49978.cheddarup.com/",
      name: "VCS Holiday Market 2026",
      startDate: "2026-12-05",
    });
    expect(res.isDuplicate).toBe(true);
    if (!res.isDuplicate) return;
    expect(res.matchType).toBe("name_containment_date");
    expect(res.existingEvent.id).toBe("07cdf570");
    // MEDIUM creates the row tagged possible_duplicate_of — an operator decides.
    expect(classifyDedupTier(res.matchType)).toBe("medium");
  });

  it("the name row 2 ACTUALLY carried on 09-22 ('Holiday Market', from a 403 page) still does not match — by design", async () => {
    const res = await findDuplicate(db, { name: "Holiday Market", startDate: "2026-12-05" });
    expect(res.isDuplicate).toBe(false);
  });
});

describe("nameContainmentMatch — initialisms", () => {
  const m = (a: string, b: string) => nameContainmentMatch(normalizeName(a), normalizeName(b));

  it("expands an initialism to the run of words it abbreviates", () => {
    expect(
      m("VCS Holiday Market 2026", "Vassalboro Community School Holiday Market")
    ).not.toBeNull();
    expect(m("Vassalboro Community School Holiday Market", "VCS Holiday Market")).not.toBeNull();
  });

  it("does not match generic-only overlaps, or initials with no matching run", () => {
    expect(m("ABC Holiday Market", "Vassalboro Community School Holiday Market")).toBeNull();
    expect(m("Holiday Market", "Vassalboro Community School Holiday Market")).toBeNull();
  });

  it("a 2-letter token is never treated as an initialism", () => {
    expect(m("VC Holiday Market", "Vassalboro Community Holiday Market")).toBeNull();
  });
});
