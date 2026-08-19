/**
 * OPE-477 — dedup must not fail OPEN when its inputs are missing.
 *
 * A candidate was created six days from an APPROVED event at the same lodge, in
 * the same category, and nothing flagged it. Two of the four stages could not
 * evaluate — no venue resolved, no city supplied — and a stage that cannot
 * evaluate returned exactly what a stage that evaluated and cleared returns.
 * The row passed as though it had been checked.
 *
 * ## The two halves, and why both are needed
 *
 *   reporting  a caller can now see WHICH stages were blind (`stagesSkipped`),
 *              so "cleared" and "never checked" stop looking identical.
 *   matching   a containment stage runs ONLY when both venue stages were blind,
 *              catching the "same name plus venue noise" shape that edit
 *              distance cannot.
 *
 * ## Why the gate on the containment stage is the design
 *
 * Measured against the live corpus: applied broadly, this signal adds ~136
 * candidate pairs on top of the 223 the venue stage already catches — enough to
 * make `force_create: true` routine, which is OPE-454's failure mode restated.
 * Restricted to venue-blind candidates it touches 6 pairs corpus-wide. A test
 * below pins the gate, because without it the fix is a regression.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

// Venue resolution is the input under test. Each test says explicitly whether
// autoLinkVenue resolved, because that is the branch that decides everything.
type AutoLinkResult = { venueId: string | null; decision: string };
const mockAutoLink = vi.fn<() => Promise<AutoLinkResult>>(async () => ({
  venueId: null,
  decision: "no-match",
}));
vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: () => mockAutoLink(),
}));

import { findDuplicate } from "../find-duplicate";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, end_date INTEGER,
    status TEXT, source_url TEXT, venue_id TEXT,
    series_id TEXT, rolled_from_event_id TEXT, merged_into TEXT
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  mockAutoLink.mockResolvedValue({ venueId: null, decision: "no-match" });

  raw
    .prepare(`INSERT INTO venues (id,name,city,state) VALUES (?,?,?,?)`)
    .run("4c7e3a80", "Waterville Elks Lodge #905", "Waterville", "ME");

  // The real, APPROVED event.
  raw
    .prepare(`INSERT INTO events (id,slug,name,start_date,status,venue_id) VALUES (?,?,?,?,?,?)`)
    .run(
      "5e79c2d9",
      "waterville-elks-lodge-905-28th-annual-craft-fair-2026",
      "Waterville Elks Lodge #905 28th Annual Craft Fair 2026",
      epoch("2026-11-01"),
      "APPROVED",
      "4c7e3a80"
    );
});

describe("the specimen this ticket was filed on", () => {
  it("no longer passes silently — venue unresolved, no city, 6 days apart", async () => {
    // Exactly the failing shape: the candidate's venue does not resolve and no
    // city/state was extracted, so stages 2a and 2b are both inert and the name
    // stage scores 0.5417 against a 0.85 threshold.
    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: null,
    });

    expect(res.isDuplicate).toBe(true);
    if (!res.isDuplicate) throw new Error("unreachable");
    expect(res.matchType).toBe("name_containment_date");
    expect(res.existingEvent.id).toBe("5e79c2d9");
    // The tokens that carried it — "waterville" and "elks", not "craft"/"fair".
    expect(res.sharedTokens).toEqual(["elks", "waterville"]);
  });

  it("says WHICH stages were blind, so cleared and unchecked differ", async () => {
    const res = await findDuplicate(db, {
      name: "Something Entirely Unrelated Here",
      startDate: "2026-11-07",
      sourceUrl: null,
    });

    expect(res.isDuplicate).toBe(false);
    // The whole point: this row was NOT checked by the two strongest stages,
    // and now says so instead of looking identical to a cleared row.
    expect(res.stagesSkipped).toContain("venue_date:venue-unresolved");
    expect(res.stagesSkipped).toContain("city_state_date:no-city-state");
    expect(res.stagesSkipped).toContain("exact_url:no-source-url");
  });

  it("reports nothing skipped when every input was present", async () => {
    mockAutoLink.mockResolvedValue({ venueId: "4c7e3a80", decision: "matched" });

    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: "https://www.facebook.com/Elks905/",
      venueName: "Waterville Elks Lodge #905",
      venueCity: "Waterville",
      venueState: "ME",
    });

    if (!res.isDuplicate) throw new Error("expected the venue stage to match");
    expect(res.matchType).toBe("venue_date");
    expect(res.stagesSkipped).toEqual([]);
  });
});

describe("the gate — this must not widen matching for candidates that HAVE a venue", () => {
  it("does not reach the containment stage when the venue resolved", async () => {
    // A resolved venue that shares no event in the window. Stage 2a evaluates
    // and clears; containment must NOT then run as a second opinion, or the
    // measured ~136 extra pairs come back.
    //
    // `venueName` is required for the resolution to be ATTEMPTED at all — with
    // no place signal, `autoLinkVenue` is never called and the mock is inert.
    // (My first version of this test omitted it and therefore tested nothing.)
    mockAutoLink.mockResolvedValue({ venueId: "some-other-venue", decision: "matched" });

    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: null,
      venueName: "Some Other Hall",
    });

    expect(res.isDuplicate).toBe(false);
    expect(res.stagesSkipped).not.toContain("venue_date:venue-unresolved");
  });

  it("does not reach it when city+state were supplied", async () => {
    // Stage 2b could evaluate. Here it finds nothing (different city), and that
    // is a real clearance — containment must not second-guess it.
    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: null,
      venueCity: "Bangor",
      venueState: "ME",
    });

    expect(res.isDuplicate).toBe(false);
    expect(res.stagesSkipped).not.toContain("city_state_date:no-city-state");
  });
});

describe("what containment refuses, so it does not become OPE-454", () => {
  it("does not match on generic event vocabulary alone", async () => {
    // "Craft Fair" is contained in "…Craft Fair 2026" and shares two tokens —
    // but zero DISTINCTIVE ones. Matching here would flag every craft fair in
    // the state against every other one in the same week.
    const res = await findDuplicate(db, {
      name: "Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
  });

  it("does not match when only ONE distinctive token is shared", async () => {
    // "Waterville" alone is a town, not an event. Two towns' worth of events
    // in one week would otherwise collide.
    const res = await findDuplicate(db, {
      name: "Waterville Farmers Market",
      startDate: "2026-11-07",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
  });

  it("does not match outside the ±7d window", async () => {
    // 2026-11-01 vs 2026-11-20 — a different edition, not a duplicate.
    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-20",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
  });

  it("does not match a merge tombstone (OPE-432 still holds here)", async () => {
    raw
      .prepare(`UPDATE events SET merged_into='other', status='REJECTED' WHERE id='5e79c2d9'`)
      .run();
    const res = await findDuplicate(db, {
      name: "Waterville Elks Craft Fair",
      startDate: "2026-11-07",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
  });
});
