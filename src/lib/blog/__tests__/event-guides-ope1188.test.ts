/**
 * OPE-1188 — a fair's pages link its own visitor guide first, and blog bodies
 * link events at their canonical URL. Real slugs from the ticket (2026-09-28).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../mcp-server/__tests__/setup-db";
import { events, eventSeries, eventSlugHistory, promoters } from "@/lib/db/schema";
import {
  eventHrefKey,
  extractEventSlugs,
  getVisitorGuides,
  guideSlugPrefix,
  resolveEventHrefs,
} from "../event-guides";

describe("guideSlugPrefix", () => {
  it("names the fair, without parenthetical or edition", () => {
    expect(guideSlugPrefix("Fryeburg Fair")).toBe("fryeburg-fair");
    expect(guideSlugPrefix("The Big E (Eastern States Exposition)")).toBe("the-big-e");
    expect(guideSlugPrefix("The Big E 2026 (Eastern States Exposition)")).toBe("the-big-e");
    expect(guideSlugPrefix("Durham Fair 2026")).toBe("durham-fair");
  });
  it("refuses names too generic to identify one fair", () => {
    expect(guideSlugPrefix("Fair")).toBeNull();
    expect(guideSlugPrefix("Expo")).toBeNull();
    expect(guideSlugPrefix(null)).toBeNull();
  });
});

describe("extractEventSlugs / eventHrefKey", () => {
  const body = [
    "Plan ahead: [Fryeburg Fair 2026](/events/fryeburg-fair-2026) runs a week.",
    "Next year: [2027](https://meetmeatthefair.com/events/durham-fair-ct-2027).",
    "Also [Topsfield](/events/topsfield-fair/2026) and [a blog post](/blog/x) and [venue](/venues/y).",
  ].join("\n");
  it("finds single-segment /events/<slug> links, relative or absolute", () => {
    expect(extractEventSlugs(body)).toEqual(["fryeburg-fair-2026", "durham-fair-ct-2027"]);
  });
  it("keys hrefs the way the renderer looks them up", () => {
    expect(eventHrefKey("/events/fryeburg-fair-2026")).toBe("/events/fryeburg-fair-2026");
    expect(eventHrefKey("https://www.meetmeatthefair.com/events/fryeburg-fair-2026/#hours")).toBe(
      "/events/fryeburg-fair-2026"
    );
    expect(eventHrefKey("/events/topsfield-fair/2026")).toBeNull();
    expect(eventHrefKey("/blog/x")).toBeNull();
  });
});

describe("against the test schema", () => {
  let db: TestDb;
  let raw: ReturnType<typeof createTestDb>["raw"];
  beforeEach(() => {
    ({ db, raw } = createTestDb());
    db.insert(promoters)
      .values({ id: "p", companyName: "P", slug: unsafeSlug("p") })
      .run();
    db.insert(eventSeries)
      .values({
        id: "s-fry",
        canonicalSlug: unsafeSlug("fryeburg-fair"),
        name: "Fryeburg Fair",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)
      .run();
    db.insert(events)
      .values([
        {
          id: "e-fry-26",
          name: "Fryeburg Fair 2026",
          slug: unsafeSlug("fryeburg-fair-2026"),
          promoterId: "p",
          status: "APPROVED",
          seriesId: "s-fry",
          startDate: new Date("2026-10-04T12:00:00Z"),
        },
        {
          id: "e-solo",
          name: "Solo Show",
          slug: unsafeSlug("solo-show"),
          promoterId: "p",
          status: "APPROVED",
          startDate: new Date("2026-11-01T12:00:00Z"),
        },
        {
          id: "e-hidden",
          name: "Hidden",
          slug: unsafeSlug("hidden-fair-2026"),
          promoterId: "p",
          status: "PENDING",
          seriesId: "s-fry",
          startDate: new Date("2026-10-04T12:00:00Z"),
        },
      ] as never)
      .run();
    db.insert(eventSlugHistory)
      .values({
        id: "h1",
        eventId: "e-fry-26",
        oldSlug: unsafeSlug("fryeburg-fair-old"),
        newSlug: unsafeSlug("fryeburg-fair-2026"),
        changedAt: new Date(),
      } as never)
      .run();
    // Raw insert on exactly the columns the code reads: the test schema's
    // blog_posts is a subset of the real table.
    const post = raw.prepare(
      "INSERT INTO blog_posts (id, slug, title, body, status, publish_date) VALUES (?, ?, ?, '', ?, ?)"
    );
    for (const [slug, d, status] of [
      ["fryeburg-fair-2026-everything-you-need-to-know-before-you-go", "2026-04-16", "PUBLISHED"],
      ["fryeburg-fair-food-guide", "2026-05-01", "PUBLISHED"],
      ["fryeburg-fair-parking-tips", "2026-09-20", "PUBLISHED"],
      ["fryeburg-fair-draft-guide", "2026-09-25", "DRAFT"],
      ["topsfield-fair-2026-dates-giant-pumpkins-and-what-to-expect", "2026-09-04", "PUBLISHED"],
    ]) {
      post.run(slug, slug, slug, status, Math.floor(new Date(d).getTime() / 1000));
    }
  });

  it("finds the fair's own posts, '…guide…' slugs first, published only", async () => {
    const guides = await getVisitorGuides(db as never, "Fryeburg Fair", 2);
    expect(guides.map((g) => g.slug)).toEqual([
      "fryeburg-fair-food-guide",
      "fryeburg-fair-2026-everything-you-need-to-know-before-you-go",
    ]);
    expect(
      (await getVisitorGuides(db as never, "Fryeburg Fair", 5)).map((g) => g.slug)
    ).not.toContain("fryeburg-fair-draft-guide");
    expect(await getVisitorGuides(db as never, "Topsfield", 2)).toEqual([]); // one word → no prefix
  });

  it("resolves an occurrence slug and a renamed slug to the canonical path; leaves the rest", async () => {
    const map = await resolveEventHrefs(db as never, [
      "fryeburg-fair-2026",
      "fryeburg-fair-old",
      "solo-show",
      "hidden-fair-2026",
      "no-such-event",
    ]);
    expect(Object.fromEntries(map)).toEqual({
      "/events/fryeburg-fair-2026": "/events/fryeburg-fair/2026",
      "/events/fryeburg-fair-old": "/events/fryeburg-fair/2026",
    });
  });
});
