/**
 * OPE-804 — "not a duplicate" and "nothing was compared" are the same boolean.
 *
 * OPE-477 made the blind stages *reportable* (`stagesSkipped`). It did not give
 * that report a reader, so the information existed and changed nothing. This
 * file pins the case where the report is the whole answer: a candidate with
 * neither a date nor a source URL, for which EVERY stage is inert.
 *
 *   no `source_url` → stage 1 skipped        (`exact_url:no-source-url`)
 *   no `startDate`  → stages 2–5 return early (`all:no-date`)
 *
 * Both at once and `findDuplicate` compares the candidate against nothing, then
 * returns the same `isDuplicate: false` a fully-evaluated clean row returns.
 *
 * The specimen: CraftFest Cotuit (`4c1dd636`, 2026-07-17) was created against a
 * byte-identical APPROVED row committed 74 days earlier. Nothing malfunctioned.
 * Every stage did exactly what it was written to do, which was nothing.
 *
 * ## Why the date gate is NOT removed
 *
 * The obvious fix — drop the early return and let the name stage run undated —
 * is wrong, and wrong in a way this codebase has already paid for.
 * `normalizeName` strips a trailing year, so "CraftFest Cotuit 2026" and
 * "CraftFest Cotuit 2027" both normalize to `craftfest cotuit`. An undated name
 * match would refuse the legitimate next-year edition: OPE-454's failure mode,
 * inverted. A test below pins that, so a later reader cannot "simplify" the
 * gate away without going red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

type AutoLinkResult = { venueId: string | null; decision: string };
const mockAutoLink = vi.fn<() => Promise<AutoLinkResult>>(async () => ({
  venueId: null,
  decision: "no-match",
}));
vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: () => mockAutoLink(),
}));

import { findDuplicate, dedupWasBlind } from "../find-duplicate";

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

const ORIGINAL = "CraftFest Cotuit 2026";

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  mockAutoLink.mockResolvedValue({ venueId: null, decision: "no-match" });

  // The row that was already there, APPROVED, 74 days before the duplicate.
  raw
    .prepare(`INSERT INTO events (id,slug,name,start_date,status,source_url) VALUES (?,?,?,?,?,?)`)
    .run("aa11bb22", "craftfest-cotuit-2026", ORIGINAL, epoch("2026-09-12"), "APPROVED", null);
});

describe("the specimen: a verdict reached without comparing anything", () => {
  it("still returns isDuplicate:false against a byte-identical APPROVED row", async () => {
    // This is the defect, stated as an assertion rather than a story. The
    // identical row IS in the table — asserted below so this cannot go green
    // by the fixture failing to insert it.
    const present = raw
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE name = ?`)
      .get(ORIGINAL) as {
      n: number;
    };
    expect(present.n).toBe(1);

    const res = await findDuplicate(db, {
      name: ORIGINAL, // identical, character for character
      startDate: null, // the date never parsed out of the submission
      sourceUrl: null, // and no URL came with it
    });

    expect(res.isDuplicate).toBe(false);
    // ...and the ONLY thing distinguishing this from a real clearance is the
    // skip report. Both halves must be present: one alone leaves a stage live.
    expect(res.stagesSkipped).toContain("all:no-date");
    expect(res.stagesSkipped).toContain("exact_url:no-source-url");
    expect(dedupWasBlind(res.stagesSkipped)).toBe(true);
  });

  it("is what the caller now receives, which is the half OPE-477 left undone", async () => {
    // OPE-477 produced `stagesSkipped` and no reader. The predicate is the
    // reader. If it were deleted, the assertion above still passes — hence
    // this one, which fails on the predicate itself.
    const res = await findDuplicate(db, { name: ORIGINAL, startDate: null, sourceUrl: null });
    expect(typeof dedupWasBlind).toBe("function");
    expect(dedupWasBlind(res.stagesSkipped)).toBe(true);
  });
});

describe("the predicate must not cry blind on a verdict that was actually reached", () => {
  it("a dated candidate is NOT blind — stages 2–5 ran and cleared it", async () => {
    const res = await findDuplicate(db, {
      name: "Something Entirely Unrelated Here",
      startDate: "2026-09-12",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
    // Stage 1 was skipped (no URL) but the name/date stages evaluated, so this
    // "no" carries real information.
    expect(res.stagesSkipped).toContain("exact_url:no-source-url");
    expect(res.stagesSkipped).not.toContain("all:no-date");
    expect(dedupWasBlind(res.stagesSkipped)).toBe(false);
  });

  it("an undated candidate WITH a url is NOT blind — stage 1 evaluated", async () => {
    raw
      .prepare(
        `INSERT INTO events (id,slug,name,start_date,status,source_url) VALUES (?,?,?,?,?,?)`
      )
      .run("cc33dd44", "other-fair", "Other Fair", epoch("2026-10-01"), "APPROVED", "https://x/1");

    const res = await findDuplicate(db, {
      name: "Totally Different Name",
      startDate: null,
      sourceUrl: "https://x/never-seen",
    });
    expect(res.isDuplicate).toBe(false);
    expect(res.stagesSkipped).toContain("all:no-date");
    expect(res.stagesSkipped).not.toContain("exact_url:no-source-url");
    // One live stage is enough to make the answer meaningful.
    expect(dedupWasBlind(res.stagesSkipped)).toBe(false);
  });

  it("a fully-evaluated candidate is not blind", async () => {
    mockAutoLink.mockResolvedValue({ venueId: "vv55", decision: "matched" });
    const res = await findDuplicate(db, {
      name: "Unrelated",
      startDate: "2026-09-12",
      sourceUrl: "https://x/2",
      venueName: "Somewhere",
      venueCity: "Cotuit",
      venueState: "MA",
    });
    expect(dedupWasBlind(res.stagesSkipped)).toBe(false);
  });
});

describe("why the date gate stays (the fix that would be a regression)", () => {
  it("next year's edition normalizes to the SAME name, so undated matching would refuse it", async () => {
    // The reason "just let the name stage run without a date" is not the fix.
    // `normalizeName` strips the trailing year: both editions collapse to
    // `craftfest cotuit`. Undated, they are indistinguishable — and refusing
    // the 2027 edition is OPE-454's defect inverted.
    const { normalizeName } = await import("../normalize-name");
    expect(normalizeName("CraftFest Cotuit 2026")).toBe(normalizeName("CraftFest Cotuit 2027"));

    // With a date, they are correctly separable: a year apart is far outside
    // the ±7d window, so the 2027 edition is created rather than refused.
    const res = await findDuplicate(db, {
      name: "CraftFest Cotuit 2027",
      startDate: "2027-09-11",
      sourceUrl: null,
    });
    expect(res.isDuplicate).toBe(false);
    expect(dedupWasBlind(res.stagesSkipped)).toBe(false);
  });
});
