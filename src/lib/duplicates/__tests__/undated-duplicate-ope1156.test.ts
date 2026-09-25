/**
 * OPE-1156 — a submission with no date still gets a duplicate check.
 *
 * Real in-memory SQLite, so the actual SQL runs. The specimens are the
 * ticket's: "50th Common Ground Country Fair" (undated) at the same venue as
 * the APPROVED "Common Ground Country Fair 2026", and the venue-less
 * "Waterville Farmers' Market" beside "Downtown Waterville Farmers Market 2026".
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../db/schema";
import { findUndatedDuplicate, undatedNameMatch } from "../find-undated-duplicate";

const SCHEMA_SQL = `
  CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT, status TEXT,
    start_date INTEGER, venue_id TEXT, merged_into TEXT
  );
`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let raw: Database.Database;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  const v = raw.prepare("INSERT INTO venues VALUES (?, ?, ?, ?)");
  v.run("cg-fairground", "Common Ground Education Center", "Unity", "ME");
  v.run("head-of-falls", "Head of Falls Park", "Waterville", "ME");
  v.run("wildlife-park", "Maine Wildlife Park", "Gray", "ME");
  const e = raw.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)");
  const sep25 = Math.floor(Date.parse("2026-09-25T12:00:00Z") / 1000);
  e.run("keeper", "Common Ground Country Fair 2026", "APPROVED", sep25, "cg-fairground", null);
  e.run(
    "old-2025",
    "Common Ground Country Fair 2025",
    "APPROVED",
    sep25 - 365 * 86400,
    "cg-fairground",
    null
  );
  e.run("tombstone", "Common Ground Country Fair", "REJECTED", sep25, "cg-fairground", "keeper");
  e.run(
    "waterville",
    "Downtown Waterville Farmers Market 2026",
    "APPROVED",
    sep25,
    "head-of-falls",
    null
  );
  e.run("wildlife-art", "Art in the Park", "APPROVED", sep25, "wildlife-park", null);
  // Prod has both Waterville markets at Head of Falls; the winter one is LATER.
  const dec3 = Math.floor(Date.parse("2026-12-03T12:00:00Z") / 1000);
  e.run(
    "waterville-winter",
    "Downtown Waterville Farmers Market – Winter 2026–2027",
    "APPROVED",
    dec3,
    "head-of-falls",
    null
  );
});

describe("OPE-1156 — date-independent duplicate check", () => {
  it("specimen 1: same venue, '50th …' vs '… 2026' → the APPROVED current edition", async () => {
    const m = await findUndatedDuplicate(db as never, {
      name: "50th Common Ground Country Fair",
      venueId: "cg-fairground",
    });
    expect(m).toEqual({ eventId: "keeper", rule: "same_venue", how: "exact" });
  });

  it("specimen 2: no venue, same town, contained name → flagged", async () => {
    const m = await findUndatedDuplicate(db as never, {
      name: "Waterville Farmers' Market",
      venueId: null,
      city: "Waterville",
      stateCode: "ME",
    });
    expect(m).toEqual({ eventId: "waterville", rule: "same_city", how: "containment" });
  });

  it("the closest name wins over a later edition (summer market, not the winter one)", async () => {
    const m = await findUndatedDuplicate(db as never, {
      name: "Waterville Farmers' Market",
      city: "Waterville",
      stateCode: "ME",
    });
    expect(m?.eventId).toBe("waterville");
  });

  it("a same-named event in ANOTHER town is not a duplicate ('Art in the Park')", async () => {
    const m = await findUndatedDuplicate(db as never, {
      name: "Art in the Park",
      city: "Waterville",
      stateCode: "ME",
    });
    expect(m).toBeNull();
  });

  it("never matches a merge tombstone or a rejected row", async () => {
    raw.prepare("UPDATE events SET status='REJECTED' WHERE id IN ('keeper','old-2025')").run();
    const m = await findUndatedDuplicate(db as never, {
      name: "Common Ground Country Fair",
      venueId: "cg-fairground",
    });
    expect(m).toBeNull();
  });

  it("never matches itself (backfill)", async () => {
    // The only event at this venue is the row itself.
    const m = await findUndatedDuplicate(db as never, {
      name: "Art in the Park",
      venueId: "wildlife-park",
      selfId: "wildlife-art",
    });
    expect(m).toBeNull();
  });

  it("names that merely share a word are not matched", () => {
    expect(undatedNameMatch("VCS Makers Market", "VCS Holiday Market 2026")).toBeNull();
    expect(undatedNameMatch("Holiday Craft Fair", "Christmas Craft Fair")).toBeNull();
  });

  it("no venue and no town → no opinion (not a guess)", async () => {
    expect(
      await findUndatedDuplicate(db as never, { name: "Common Ground Country Fair" })
    ).toBeNull();
  });
});

describe("OPE-1156 — the submit route uses it, only for undated rows, and mints no series for them", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
    "utf8"
  );

  it("an undated row is gated to review with a labelled reason", () => {
    expect(ROUTE).toMatch(
      /if \(!effectiveStartDate\) \{\s*gateRoute = "PENDING_REVIEW";\s*if \(!gateReasons\.includes\("no_start_date"\)\) gateReasons\.push\("no_start_date"\);/
    );
  });

  it("the undated check runs only when there is no date, after the dated checks", () => {
    expect(ROUTE).toMatch(
      /\(effectiveStartDate\s*\?\s*null\s*:\s*\(\(\s*await findUndatedDuplicate\(db,/
    );
  });

  it("attachEventToSeries is called only inside `if (effectiveStartDate)`", () => {
    const call = ROUTE.indexOf("await attachEventToSeries(db, newEventId,");
    expect(call).toBeGreaterThan(-1);
    expect(ROUTE.split("await attachEventToSeries(db, newEventId,").length - 1).toBe(1);
    const guard = ROUTE.lastIndexOf("if (effectiveStartDate) {", call);
    expect(guard).toBeGreaterThan(-1);
    expect(ROUTE.slice(guard, call)).not.toContain("}");
  });
});
