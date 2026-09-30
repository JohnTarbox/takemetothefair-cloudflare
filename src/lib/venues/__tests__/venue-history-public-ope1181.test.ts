/**
 * OPE-1181 — the public venue history loader and the single indexability rule.
 * Runs against the full test schema (the MCP harness's createTestDb, which also
 * loads the drizzle/0333 triggers).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../mcp-server/__tests__/setup-db";
import {
  seriesVenuePeriods,
  venueClaimCitations,
  venueNameVariants,
  venues,
} from "@/lib/db/schema";
import {
  describeWhereItWent,
  indexableVenueWhere,
  loadVenueHistoryPublic,
} from "../venue-history-public";

let db: TestDb;
const cite = (target: Record<string, string>, field: string, url: string, certainty = "certain") =>
  db
    .insert(venueClaimCitations)
    .values({
      id: `c-${Math.random().toString(36).slice(2)}`,
      ...target,
      field,
      sourceUrl: url,
      sourceType: "news_article",
      certainty: certainty as never,
      createdAt: new Date(),
    } as never)
    .run();
function venue(id: string, status: string, extra: Record<string, unknown> = {}) {
  db.insert(venues)
    .values({
      id,
      name: `Venue ${id}`,
      slug: unsafeSlug(`venue-${id}`),
      address: status === "FORMER" ? "" : "1 Main",
      city: "Town",
      state: "ME",
      zip: "",
      status: status as never,
      ...extra,
    })
    .run();
}
function period(id: string, venueId: string, seriesName: string, from: string, to: string | null) {
  db.insert(seriesVenuePeriods)
    .values({
      id,
      venueId,
      seriesName,
      fromEdtf: from,
      toEdtf: to,
      fromEarliest: new Date(`${from.slice(0, 4)}-01-01`),
      certainty: "certain",
      createdAt: new Date(),
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  venue("old", "FORMER", {
    useStartedEdtf: "1866",
    useEndedEdtf: "1881",
    useEndedEarliest: new Date("1881-01-01"),
    useEndedLatest: new Date("1881-12-31"),
  });
  venue("windsor", "ACTIVE");
  venue("unity", "ACTIVE");
  venue("bare", "FORMER", {
    useEndedEdtf: "1950",
    useEndedEarliest: new Date("1950-01-01"),
    useEndedLatest: new Date("1950-12-31"),
  });
});

describe("describeWhereItWent", () => {
  it("names the current venue(s) when the series moved on", () => {
    expect(
      describeWhereItWent({ to: "1980" }, [{ name: "Unity", from: "1998", to: null }]).text
    ).toBe("Now held at Unity (since 1998)");
    expect(
      describeWhereItWent({ to: "1980" }, [
        { name: "A", from: "1990", to: null },
        { name: "B", from: "2000", to: null },
      ]).text
    ).toBe("Now held at A and B");
  });
  it("says 'No longer held' when there is nowhere else", () => {
    expect(describeWhereItWent({ to: "1881" }, []).text).toBe("No longer held");
  });
  it("an ended later venue reads as history, not a current home", () => {
    expect(
      describeWhereItWent({ to: "1980" }, [{ name: "Windsor", from: "1981", to: "1997~" }]).text
    ).toBe("Later held at Windsor; no longer held");
  });
});

describe("loadVenueHistoryPublic", () => {
  it("ACCEPTANCE: a FORMER venue's two series fan out to two different active venues, every claim cited", async () => {
    period("p1", "old", "Common Ground Fair", "1977", "1980");
    period("p1w", "windsor", "Common Ground Fair", "1981", null);
    period("p2", "old", "Vermont State Fair", "1879", "1881");
    period("p2u", "unity", "Vermont State Fair", "1882", null);
    cite({ seriesVenuePeriodId: "p1" }, "period", "https://example.org/cgf", "certain");
    cite({ seriesVenuePeriodId: "p1" }, "period", "https://example.org/cgf-2", "uncertain");
    cite({ seriesVenuePeriodId: "p2" }, "period", "https://example.org/vsf", "less-certain");
    cite({ venueId: "old" }, "use_started", "https://example.org/use");
    db.insert(venueNameVariants)
      .values({
        id: "nv",
        venueId: "old",
        name: "Gilman's trotting track",
        normalizedName: "gilmans trotting track",
        fromEdtf: "1866",
        toEdtf: "1872",
        certainty: "less-certain",
        createdAt: new Date(),
      } as never)
      .run();
    cite({ venueNameVariantId: "nv" }, "name", "https://example.org/gilman");

    const h = await loadVenueHistoryPublic(db as never, "old");
    const rows = Object.fromEntries(h.rows.map((r) => [r.seriesName, r]));
    expect(rows["Common Ground Fair"].whereItWent?.venues.map((v) => v.slug)).toEqual([
      "venue-windsor",
    ]);
    expect(rows["Vermont State Fair"].whereItWent?.venues.map((v) => v.slug)).toEqual([
      "venue-unity",
    ]);
    // Conflicting sources are all kept, highest certainty first.
    expect(rows["Common Ground Fair"].citations.map((c) => c.certainty)).toEqual([
      "certain",
      "uncertain",
    ]);
    expect(h.nameVariants[0]).toMatchObject({
      name: "Gilman's trotting track",
      range: "1866–1872",
    });
    expect(h.nameVariants[0].citations).toHaveLength(1);
    expect(h.lifecycleCitations.use_started).toHaveLength(1);
  });

  it("an ACTIVE venue with a past period shows it in its history", async () => {
    period("pw", "windsor", "Common Ground Fair", "1981", "1997~");
    period("pu", "unity", "Common Ground Fair", "1998", null);
    const h = await loadVenueHistoryPublic(db as never, "windsor");
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ seriesName: "Common Ground Fair", range: "1981–about 1997" });
    expect(h.rows[0].whereItWent?.summary.text).toBe("Now held at Venue unity (since 1998)");
  });
});

describe("indexableVenueWhere — the one rule for page robots, sitemap and indexable slugs", () => {
  const indexable = async (id: string) =>
    (
      await db
        .select({ id: venues.id })
        .from(venues)
        .where(and(eq(venues.id, id), indexableVenueWhere()))
        .all()
    ).length === 1;

  it("ACTIVE venues are indexable", async () => {
    expect(await indexable("windsor")).toBe(true);
  });
  it("an uncited FORMER venue is NOT indexable (served noindex, kept out of the sitemap)", async () => {
    expect(await indexable("bare")).toBe(false);
  });
  it("a FORMER venue with one cited period is indexable", async () => {
    period("pb", "bare", "Lost Valley Fair", "1920", "1950");
    expect(await indexable("bare")).toBe(false); // a period alone is not enough…
    cite({ seriesVenuePeriodId: "pb" }, "period", "https://example.org/lvf");
    expect(await indexable("bare")).toBe(true); // …a CITED one is
  });
  it("…or cited use-start AND use-end", async () => {
    cite({ venueId: "old" }, "use_started", "https://example.org/a");
    expect(await indexable("old")).toBe(false);
    cite({ venueId: "old" }, "use_ended", "https://example.org/b");
    expect(await indexable("old")).toBe(true);
  });
});
