/**
 * OPE-472 rework — late series attach, and the invariant split that makes a
 * working write path legible.
 *
 * Background, because the shape of these tests follows from it. The original
 * fix DID work: measured in prod 2026-08-20, of the 6 events created since it
 * deployed, the 4 carrying a venue were all parented and the 2 without were
 * not. But the only reported number was an undifferentiated orphan count,
 * which therefore climbed — and that climb was read as "the writer never
 * resumed", producing a REVIEW FAIL against a live fix.
 *
 * Two things had to change. The venue-less pool needed a drain (a venue that
 * arrives later is the moment the missing input shows up), and the invariant
 * needed to distinguish "skipped deliberately" from "never ran".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, eventSeries, promoters, venues } from "../src/schema.js";
import { eq } from "drizzle-orm";
import { seriesNameKey, stripNameEditionSuffix } from "@takemetothefair/event-series";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

function seedVenue(id: string, name: string) {
  db.insert(venues)
    .values({
      id,
      name,
      slug: `venue-${id}`,
      address: "1 Main St",
      city: "Fryeburg",
      state: "ME",
      zip: "04037",
    })
    .run();
}

function seedEvent(id: string, over: Partial<typeof events.$inferInsert> = {}) {
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p-1" })
    .onConflictDoNothing()
    .run();
  db.insert(events)
    .values({
      id,
      name: over.name ?? "Fryeburg Fair 2026",
      slug: over.slug ?? `event-${id}`,
      promoterId: "p-1",
      status: "PENDING",
      venueId: over.venueId ?? null,
      seriesId: over.seriesId ?? null,
      ...over,
    })
    .run();
}

function seriesOf(eventId: string): string | null {
  const [row] = db.select({ s: events.seriesId }).from(events).where(eq(events.id, eventId)).all();
  return row?.s ?? null;
}

describe("late series attach — a venue arriving after creation", () => {
  it("parents a venue-less event once update_event gives it a venue", async () => {
    seedVenue("v-1", "Fryeburg Fairgrounds");
    seedEvent("e-1"); // venue_id NULL → deliberately unparented at creation
    expect(seriesOf("e-1")).toBeNull();

    await server.invoke("update_event", { event_id: "e-1", venue_id: "v-1" });

    const sid = seriesOf("e-1");
    expect(sid).not.toBeNull();
    const [series] = db.select().from(eventSeries).where(eq(eventSeries.id, sid!)).all();
    // The parent is the evergreen name, never the edition-stamped one.
    expect(series.name).toBe("Fryeburg Fair");
    expect(series.venueId).toBe("v-1");
  });

  it("joins the existing parent rather than minting a second one", async () => {
    seedVenue("v-1", "Fryeburg Fairgrounds");
    db.insert(eventSeries)
      .values({
        id: "s-existing",
        canonicalSlug: "fryeburg-fair",
        name: "Fryeburg Fair",
        venueId: "v-1",
      })
      .run();
    seedEvent("e-1", { name: "Fryeburg Fair 2027" });

    await server.invoke("update_event", { event_id: "e-1", venue_id: "v-1" });

    expect(seriesOf("e-1")).toBe("s-existing");
    expect(db.select().from(eventSeries).all()).toHaveLength(1);
  });

  it("never re-parents an event that already has a series", async () => {
    seedVenue("v-1", "A");
    seedVenue("v-2", "B");
    db.insert(eventSeries)
      .values({ id: "s-keep", canonicalSlug: "keep", name: "Fryeburg Fair", venueId: "v-1" })
      .run();
    seedEvent("e-1", { venueId: "v-1", seriesId: "s-keep" });

    await server.invoke("update_event", { event_id: "e-1", venue_id: "v-2" });

    // The venue moved; the parentage did NOT silently follow it.
    expect(seriesOf("e-1")).toBe("s-keep");
  });

  it("does not attach across venues — two towns' fairs stay two series", async () => {
    seedVenue("v-1", "Town A Grounds");
    seedVenue("v-2", "Town B Grounds");
    db.insert(eventSeries)
      .values({
        id: "s-a",
        canonicalSlug: "holiday-craft-fair",
        name: "Holiday Craft Fair",
        venueId: "v-1",
      })
      .run();
    seedEvent("e-1", { name: "Holiday Craft Fair 2026" });

    await server.invoke("update_event", { event_id: "e-1", venue_id: "v-2" });

    const sid = seriesOf("e-1");
    expect(sid).not.toBe("s-a");
    const [series] = db.select().from(eventSeries).where(eq(eventSeries.id, sid!)).all();
    expect(series.venueId).toBe("v-2");
    // Same name, different venue — the slug is suffixed so BOTH stay reachable
    // instead of one silently winning the URL.
    expect(series.canonicalSlug).not.toBe("holiday-craft-fair");
  });

  it("an edit that does not add a venue leaves parentage untouched", async () => {
    seedEvent("e-1");
    await server.invoke("update_event", { event_id: "e-1", name: "Renamed Fair 2026" });
    expect(seriesOf("e-1")).toBeNull();
  });

  it("clearing a venue does not attach, and does not throw", async () => {
    seedVenue("v-1", "A");
    seedEvent("e-1", { venueId: "v-1" });
    await server.invoke("update_event", { event_id: "e-1", venue_id: null });
    expect(seriesOf("e-1")).toBeNull();
  });
});

describe("series grouping key", () => {
  it("collapses editions, case and punctuation onto one key", () => {
    const k = seriesNameKey("Fryeburg Fair 2026");
    expect(seriesNameKey("fryeburg fair")).toBe(k);
    expect(seriesNameKey("Fryeburg  Fair  2027")).toBe(k);
    expect(seriesNameKey("Fryeburg Fair — 2026-09-19")).toBe(k);
  });

  it("does not strip a number that is not an edition token", () => {
    expect(stripNameEditionSuffix("Route 66 Rally")).toBe("Route 66 Rally");
    expect(stripNameEditionSuffix("Club 1234")).toBe("Club 1234");
  });

  it("keeps distinct fairs distinct", () => {
    expect(seriesNameKey("Fryeburg Fair")).not.toBe(seriesNameKey("Cheshire Fair"));
  });
});

/**
 * The invariant's anchor. This constant is the difference between reporting
 * "0 defects" and reporting "146 defects" for the same healthy system — the
 * 146 being events created BEFORE the write-path fix existed.
 */
describe("SERIES_WRITE_PATH_SHIPPED_AT", () => {
  it("is the PR #931 deploy instant, in seconds", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/tools/admin-data-health.ts", import.meta.url), "utf8")
    );
    const m = src.match(/const SERIES_WRITE_PATH_SHIPPED_AT = (\d+);/);
    expect(m).not.toBeNull();
    const v = Number(m![1]);

    // Seconds, not milliseconds. A ms value here sits in the year 58,600,
    // matches no rows, and reports a clean zero that reads as success.
    expect(v).toBe(Math.floor(Date.parse("2026-08-19T14:00:00Z") / 1000));
    expect(String(v)).toHaveLength(10);
  });

  it("is anchored before the first post-fix event and after the fix landed", () => {
    const v = Math.floor(Date.parse("2026-08-19T14:00:00Z") / 1000);
    // First event created after the deploy, from prod: 2026-08-19 18:02:39Z.
    expect(v).toBeLessThan(Math.floor(Date.parse("2026-08-19T18:02:39Z") / 1000));
    // PR #931's AGENT DONE was posted 2026-08-19T14:09Z.
    expect(v).toBeLessThanOrEqual(Math.floor(Date.parse("2026-08-19T14:09:53Z") / 1000));
  });
});
