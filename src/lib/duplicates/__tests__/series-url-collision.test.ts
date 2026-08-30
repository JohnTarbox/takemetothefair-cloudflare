/**
 * OPE-454 — a shared `source_url` means same SOURCE, not same EVENT.
 *
 * Stage 1 was `where(source_url = ?) limit 1`, returning an arbitrary row
 * before any date was compared. Two legitimate 2027 Paradise City shows —
 * Marlborough in March and Northampton in May, different cities a year apart —
 * were both refused against a November 2026 event whose only commonality was
 * `https://festivals.paradisecityarts.com/shows`, the promoter's own listing
 * page. Both had to be forced through with `force_create: true`.
 *
 * Scale (prod, 2026-08-17): **738 of 1,748 events with a source_url (42%)**
 * share it with at least one other event, over 195 URLs; worst is 53 events on
 * one URL. So the collision zone is most of the catalog, and it is worst
 * exactly where the coverage value is highest — series promoters, where one
 * contact yields four events.
 *
 * The tests below run against a real in-memory SQLite so they exercise the
 * actual SQL, and they pin BOTH directions: the sibling must create, and the
 * genuine duplicate must still be refused. A fix that only proved the first
 * would be indistinguishable from deleting the guard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

// autoLinkVenue does its own venue queries against tables this fixture does
// not create; stage 1 is what's under test, so keep venue resolution inert.
vi.mock("@/lib/venue-matching", () => ({
  autoLinkVenue: vi.fn(async () => ({ venueId: null, decision: "no-match" })),
}));

import { findDuplicate, identifiesSameEvent } from "../find-duplicate";

const SERIES_URL = "https://festivals.paradisecityarts.com/shows";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT,
    start_date INTEGER, end_date INTEGER,
    status TEXT, source_url TEXT, venue_id TEXT,
    series_id TEXT, rolled_from_event_id TEXT,
    -- OPE-432: findDuplicate now excludes merge tombstones, so the column
    -- the predicate reads has to exist here or every query 500s.
    merged_into TEXT
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function seedEvent(
  id: string,
  name: string,
  startIso: string,
  sourceUrl: string | null,
  // OPE-650 — a fair's RUN, not just its first day. Stage 1 now asks whether the
  // candidate day falls inside `[start_date, end_date]` rather than inside a
  // fixed ±7d window, so a multi-day event has to actually say it is multi-day.
  // Left null by default: most fixtures here are single-day and should collapse
  // to same-day matching.
  endIso?: string
) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, start_date, end_date, status, source_url)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, id, name, epoch(startIso), endIso ? epoch(endIso) : null, "APPROVED", sourceUrl);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  // The event that was wrongly cited as the duplicate.
  // Nov 20-22: a three-day fair. The span is seeded because one case below
  // depends on it — "a source reporting the fair's second day" is only a
  // meaningful scenario if the stored event actually runs that long. Before
  // OPE-650 the fixture said one day and the assertion passed anyway, because
  // stage 1 was matching on a ±7d window that had nothing to do with this
  // event's duration.
  seedEvent(
    "marlborough-2026",
    "Paradise City — Marlborough Winter 2026",
    "2026-11-20",
    SERIES_URL,
    "2026-11-22"
  );
});

describe("the two refusals that prompted this ticket", () => {
  it("does NOT block the March 2027 Marlborough show", async () => {
    const res = await findDuplicate(db, {
      sourceUrl: SERIES_URL,
      name: "Paradise City Arts Festival — Marlborough Spring 2027",
      startDate: "2027-03-19",
    });
    expect(res.isDuplicate).toBe(true); // the source IS shared — we say so
    if (!res.isDuplicate) throw new Error("unreachable");
    expect(res.matchType).toBe("series_url");
    expect(res.identifiesSameEvent).toBe(false); // …but it is not the same event
  });

  it("does NOT block the May 2027 Northampton show", async () => {
    const res = await findDuplicate(db, {
      sourceUrl: SERIES_URL,
      name: "Paradise City Arts Festival — Northampton 2027",
      startDate: "2027-05-29",
    });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(res.identifiesSameEvent).toBe(false);
  });
});

describe("the guard still catches genuine duplicates", () => {
  it("blocks a re-submission of the SAME event at the same URL", async () => {
    // Same source page, same dates — this is the case exact_url exists for.
    const res = await findDuplicate(db, {
      sourceUrl: SERIES_URL,
      name: "Paradise City Marlborough Winter",
      startDate: "2026-11-20",
    });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
    expect(res.identifiesSameEvent).toBe(true);
    expect(res.existingEvent.id).toBe("marlborough-2026");
  });

  it("blocks a date INSIDE the fair's own run, not only its first day", async () => {
    // A source that reports the fair's second day must still match it. Nov 22 is
    // the last day of the Nov 20-22 run, so it is the same event.
    //
    // OPE-650 renamed this from "±7d window": the window was never what made
    // this case right, and using one is what refused a weekly series. The
    // event's own span is the thing that separates "day 2 of this fair" from
    // "next week's edition on the same page".
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: "2026-11-22" });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
  });

  it("treats just outside the window as a different edition", async () => {
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: "2026-12-05" });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(res.matchType).toBe("series_url");
  });
});

describe("picking the RIGHT sibling, not an arbitrary row", () => {
  beforeEach(() => {
    seedEvent("northampton-2027", "Paradise City — Northampton 2027", "2027-05-29", SERIES_URL);
    seedEvent(
      "marlborough-2027",
      "Paradise City — Marlborough Spring 2027",
      "2027-03-19",
      SERIES_URL
    );
  });

  it("matches the edition whose dates agree, even though it is not row 1", async () => {
    // The old `limit(1)` returned whichever row SQLite handed back first. With
    // three editions on one URL, a date-blind match is a coin flip: it could
    // report the March show as the duplicate of the May one.
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: "2027-05-29" });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
    expect(res.existingEvent.id).toBe("northampton-2027");
  });

  it("still declines to block a FOURTH edition none of them share a date with", async () => {
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: "2028-03-17" });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(res.identifiesSameEvent).toBe(false);
  });
});

describe("the undated candidate — stage 1's original purpose", () => {
  it("still blocks when the URL names exactly one event", async () => {
    // A re-submission whose date we failed to parse. Nothing contradicts the
    // URL, so it stays a blocking duplicate — that is what this stage was for.
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: null });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
    expect(res.identifiesSameEvent).toBe(true);
  });

  it("declines to block when the URL is a directory page on 2+ events", async () => {
    // With no date AND several events behind the URL, there is no fact that
    // says WHICH one this is. Refusing would pick one at random.
    seedEvent("northampton-2027", "Paradise City — Northampton 2027", "2027-05-29", SERIES_URL);
    const res = await findDuplicate(db, { sourceUrl: SERIES_URL, startDate: null });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(res.matchType).toBe("series_url");
    expect(res.identifiesSameEvent).toBe(false);
  });
});

describe("unrelated URLs are unaffected", () => {
  it("returns no match for a URL nobody uses", async () => {
    const res = await findDuplicate(db, {
      sourceUrl: "https://example.test/nothing",
      startDate: "2026-11-20",
    });
    expect(res.isDuplicate).toBe(false);
  });

  it("does not match on a NULL source_url", async () => {
    // Guards against `eq(source_url, undefined)` degenerating into a match
    // against the many rows that carry no source URL at all.
    seedEvent("no-url-event", "Some Fair", "2026-11-20", null);
    const res = await findDuplicate(db, { sourceUrl: null, startDate: "2026-11-20" });
    expect(res.isDuplicate).toBe(false);
  });
});

describe("identifiesSameEvent()", () => {
  it("is false only for series_url", () => {
    expect(identifiesSameEvent("series_url")).toBe(false);
    for (const m of ["exact_url", "venue_date", "city_state_date", "similar_name_date"] as const) {
      expect(identifiesSameEvent(m)).toBe(true);
    }
  });
});

/**
 * OPE-650 — a weekly series on one organizer page.
 *
 * Brookfield Orchards lists its whole season on `https://brookfieldorchards.com/`.
 * "The Kids Market" (Sep 19) and "Local Author's Fair" (Sep 26) are exactly
 * SEVEN days apart, which is exactly the ±7d window stage 1 used to borrow from
 * stages 2-4 — so the second event was refused as an `exact_url` duplicate of
 * the first. Different name, different date, different event.
 *
 * The failure was quiet and biased AGAINST coverage: an unattended discovery
 * pass reading `created: false / potential_duplicates_found` has every reason to
 * treat it as the guard working, and cannot tell it from a real duplicate
 * without opening the named row.
 */
describe("a weekly series listed on one page (OPE-650)", () => {
  const HOME = "https://brookfieldorchards.com/";

  beforeEach(() => {
    // Single-day events, exactly a week apart — the real prod shape.
    seedEvent("kids-market", "The Kids Market at Brookfield Orchards", "2026-09-19", HOME);
  });

  it("does NOT block next week's event at the same URL", async () => {
    // The exact refusal that prompted this ticket. 7 days is the boundary the
    // old window sat on, so this is the case a wider-or-narrower fixed window
    // would still get wrong.
    const res = await findDuplicate(db, {
      sourceUrl: HOME,
      name: "Local Author's Fair at Brookfield Orchards",
      startDate: "2026-09-26",
    });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(res.matchType).toBe("series_url");
    // The property that actually matters: it must not BLOCK.
    expect(identifiesSameEvent(res.matchType)).toBe(false);
  });

  it("does not block the week BEFORE either — the window was symmetric", async () => {
    const res = await findDuplicate(db, { sourceUrl: HOME, startDate: "2026-09-12" });
    if (!res.isDuplicate) throw new Error("expected a source match");
    expect(identifiesSameEvent(res.matchType)).toBe(false);
  });

  it("still blocks a genuine re-submission of the same event", async () => {
    // The acceptance's other half. Same name, same date, same URL.
    const res = await findDuplicate(db, {
      sourceUrl: HOME,
      name: "The Kids Market at Brookfield Orchards",
      startDate: "2026-09-19",
    });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
    expect(identifiesSameEvent(res.matchType)).toBe(true);
  });

  it("blocks a date inside a MULTI-DAY sibling's run at the same URL", async () => {
    // The span rule has to keep working for the season's longer events too:
    // a 3-day fair on the same page still absorbs its own middle days.
    seedEvent("harvest", "Harvest Craft Fair", "2026-10-03", HOME, "2026-10-05");
    const res = await findDuplicate(db, { sourceUrl: HOME, startDate: "2026-10-04" });
    if (!res.isDuplicate) throw new Error("expected a duplicate");
    expect(res.matchType).toBe("exact_url");
  });
});
