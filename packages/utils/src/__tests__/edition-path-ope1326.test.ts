/**
 * OPE-1326 — multi-edition series step 3/5: the shared builder, parser and
 * resolver, against a fixture with a FLAGGED series holding two same-year
 * editions (the case that motivated the whole change) beside an annual one.
 */
import { describe, it, expect } from "vitest";
import {
  editionKeyFor,
  eventCanonicalPath,
  isEditionKey,
  occurrencePath,
  parseOccurrenceSegment,
  resolveOccurrence,
  seriesOccurrencePath,
} from "../edition-path";

const may27 = new Date("2027-05-15T12:00:00Z");
const oct27 = new Date("2027-10-02T12:00:00Z");
const oct26 = new Date("2026-10-02T12:00:00Z");

/** NEAR-Fest, flagged: two editions in 2027, one in 2026. */
const NEAR: Occ[] = [
  { id: "b", slug: "near-fest-xlii", startDate: oct27, editionKey: "2027-10" },
  { id: "a", slug: "near-fest-xli", startDate: may27, editionKey: "2027-05" },
  { id: "c", slug: "near-fest-xl", startDate: oct26, editionKey: "2026-10" },
];
/** An annual series: no keys anywhere. */
type Occ = { id: string; slug: string; startDate: Date; editionKey: string | null };
const FRYE: Occ[] = [{ id: "f", slug: "fryeburg-fair-2026", startDate: oct26, editionKey: null }];

describe("edition key shape", () => {
  it.each(["2027-05", "2027-12", "2027-05-xli", "2027-05-spring-show"])("accepts %s", (k) =>
    expect(isEditionKey(k)).toBe(true)
  );
  it.each([
    "2027",
    "2027-13",
    "2027-00",
    "2027-5",
    "2027-05-",
    "2027-05-XLI",
    "2027-05_x",
    "vendors",
  ])("refuses %s", (k) => expect(isEditionKey(k)).toBe(false));
});

describe("builder", () => {
  it("annual series (or no edition input) → the step-1 year path, unchanged", () => {
    expect(occurrencePath("fryeburg-fair", oct26)).toBe("/events/fryeburg-fair/2026");
    expect(
      occurrencePath("fryeburg-fair", oct26, { editionMode: "annual", editionKey: "2026-10" })
    ).toBe("/events/fryeburg-fair/2026");
  });
  it("multi series with a valid key → the edition path", () => {
    expect(
      occurrencePath("near-fest", may27, { editionMode: "multi", editionKey: "2027-05" })
    ).toBe("/events/near-fest/2027-05");
  });
  it("multi series, missing or malformed key → falls back to the year path", () => {
    expect(occurrencePath("near-fest", may27, { editionMode: "multi", editionKey: null })).toBe(
      "/events/near-fest/2027"
    );
    expect(occurrencePath("near-fest", may27, { editionMode: "multi", editionKey: "May" })).toBe(
      "/events/near-fest/2027"
    );
  });
  it("eventCanonicalPath threads the edition through", () => {
    expect(
      eventCanonicalPath({
        slug: "near-fest-xli",
        seriesSlug: "near-fest",
        startDate: may27,
        editionMode: "multi",
        editionKey: "2027-05",
      })
    ).toBe("/events/near-fest/2027-05");
    expect(
      eventCanonicalPath({
        slug: "x",
        seriesSlug: null,
        startDate: may27,
        editionMode: "multi",
        editionKey: "2027-05",
      })
    ).toBe("/events/x");
  });
  it("the two same-year editions get DISTINCT paths", () => {
    const paths = NEAR.map((o) =>
      occurrencePath("near-fest", o.startDate, { editionMode: "multi", editionKey: o.editionKey })
    );
    expect(new Set(paths).size).toBe(NEAR.length);
  });
});

describe("parse(build(x)) == x", () => {
  it("for every member of both series", () => {
    const cases = [
      ...NEAR.map((o) => ({ o, mode: "multi" as const, slug: "near-fest", all: NEAR })),
      ...FRYE.map((o) => ({ o, mode: "annual" as const, slug: "fryeburg-fair", all: FRYE })),
    ];
    expect(cases.length).toBe(4); // landmark
    for (const { o, mode, slug, all } of cases) {
      const path = occurrencePath(slug, o.startDate, {
        editionMode: mode,
        editionKey: o.editionKey,
      })!;
      const [, , s, seg] = path.split("/");
      expect(s).toBe(slug);
      const parsed = parseOccurrenceSegment(seg)!;
      const res = resolveOccurrence(slug, mode, all, parsed);
      expect(res).toEqual({ action: "render", occurrence: o });
    }
  });
});

describe("resolver table", () => {
  const year = (y: number) => parseOccurrenceSegment(String(y))!;
  const key = (k: string) => parseOccurrenceSegment(k)!;

  it("year + annual → render (step-1 behaviour)", () => {
    expect(resolveOccurrence("fryeburg-fair", "annual", FRYE, year(2026))).toEqual({
      action: "render",
      occurrence: FRYE[0],
    });
  });

  it("year + multi → ONE-hop 301 to that year's EARLIEST edition (May, not October)", () => {
    const r = resolveOccurrence("near-fest", "multi", NEAR, year(2027));
    expect(r).toEqual({
      action: "redirect",
      occurrence: NEAR[1],
      path: "/events/near-fest/2027-05",
    });
  });

  it("year + multi, member without a key → renders at the year (as its builder addresses it)", () => {
    const unkeyed = [{ id: "u", startDate: may27, editionKey: null }];
    expect(resolveOccurrence("near-fest", "multi", unkeyed, year(2027))).toEqual({
      action: "render",
      occurrence: unkeyed[0],
    });
  });

  it("edition + multi → render the member holding the key", () => {
    expect(resolveOccurrence("near-fest", "multi", NEAR, key("2027-10"))).toEqual({
      action: "render",
      occurrence: NEAR[0],
    });
  });

  it("edition + annual → 301 to the member's YEAR (the permanent rollback path)", () => {
    expect(resolveOccurrence("near-fest", "annual", NEAR, key("2027-10"))).toEqual({
      action: "redirect",
      occurrence: NEAR[0],
      path: "/events/near-fest/2027",
    });
  });

  it("unknown year or key → null (404)", () => {
    expect(resolveOccurrence("near-fest", "multi", NEAR, year(2030))).toBeNull();
    expect(resolveOccurrence("near-fest", "multi", NEAR, key("2027-06"))).toBeNull();
    expect(resolveOccurrence("fryeburg-fair", "annual", FRYE, key("2026-10"))).toBeNull();
  });

  it("every redirect lands on the target's own canonical path (no chain)", () => {
    for (const mode of ["annual", "multi"] as const) {
      for (const seg of [year(2026), year(2027), key("2027-05"), key("2027-10"), key("2026-10")]) {
        const r = resolveOccurrence("near-fest", mode, NEAR, seg);
        if (r?.action !== "redirect") continue;
        const canonical = occurrencePath("near-fest", r.occurrence.startDate, {
          editionMode: mode,
          editionKey: r.occurrence.editionKey,
        });
        expect(r.path).toBe(canonical);
        // …and that canonical path itself resolves to render, never redirects again.
        const again = resolveOccurrence(
          "near-fest",
          mode,
          NEAR,
          parseOccurrenceSegment(r.path.split("/")[3])!
        );
        expect(again?.action).toBe("render");
      }
    }
  });
});

describe("editionKeyFor", () => {
  it("is null unless the series is multi AND the key is well-formed", () => {
    expect(editionKeyFor({ editionMode: "multi", editionKey: "2027-05" })).toBe("2027-05");
    expect(editionKeyFor({ editionMode: "annual", editionKey: "2027-05" })).toBeNull();
    expect(editionKeyFor({ editionMode: "multi", editionKey: "bad" })).toBeNull();
    expect(editionKeyFor(null)).toBeNull();
  });
  it("seriesOccurrencePath takes a key as readily as a year", () => {
    expect(seriesOccurrencePath("near-fest", "2027-05")).toBe("/events/near-fest/2027-05");
  });
});
