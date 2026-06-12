/**
 * SYN1 — behavioral coverage for the syndication outbox wiring on the three MCP
 * update tools. Asserts the gate (mirrored field → exactly one outbox row +
 * a version bump; non-mirrored field → nothing) and the venue fan-out.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, venues, eventDays, promoters, syndicationOutbox } from "../src/schema.js";
import { eq } from "drizzle-orm";

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

afterEach(() => mock.restore());

const VENUE_ID = "venue-aaaa";
const EVENT_ID = "11111111-2222-3333-4444-555555555555";

function seed() {
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
  db.insert(venues)
    .values({
      id: VENUE_ID,
      name: "Town Common",
      slug: "town-common",
      address: "1 Main St",
      city: "Grey",
      state: "ME",
      zip: "04039",
      status: "ACTIVE",
    })
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Gray Wild Blueberry Festival",
      slug: "gray-wild-blueberry-festival",
      promoterId: "promoter-1",
      venueId: VENUE_ID,
      status: "APPROVED",
      startDate: new Date("2026-08-15T00:00:00.000Z"),
      endDate: new Date("2026-08-16T00:00:00.000Z"),
    })
    .run();
}

function outboxRows() {
  return db.select().from(syndicationOutbox).all();
}
function eventVersion(id = EVENT_ID) {
  return db.select({ v: events.syndicationVersion }).from(events).where(eq(events.id, id)).get()?.v;
}

describe("update_venue → syndication outbox", () => {
  beforeEach(seed);

  it("writes one venue outbox row + bumps every event at the venue when a mirrored field changes", async () => {
    await server.invoke("update_venue", { venue_id: VENUE_ID, city: "Gray" });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("venue");
    expect(rows[0].entityId).toBe(VENUE_ID);
    expect(rows[0].changeVersion).toBe(1);
    expect(JSON.parse(rows[0].changedFields)).toEqual(["city"]);
    expect(JSON.parse(rows[0].snapshot)).toMatchObject({ city: "Gray", state: "ME" });
    expect(eventVersion()).toBe(1);
  });

  it("writes nothing for a non-mirrored venue edit (e.g. phone)", async () => {
    await server.invoke("update_venue", { venue_id: VENUE_ID, contact_phone: "207-555-0100" });
    expect(outboxRows()).toHaveLength(0);
    expect(eventVersion()).toBe(0);
  });

  it("increments change_version per entity across successive corrections", async () => {
    await server.invoke("update_venue", { venue_id: VENUE_ID, city: "Gray" });
    await server.invoke("update_venue", { venue_id: VENUE_ID, name: "Gray Town Common" });
    const rows = outboxRows().sort((a, b) => a.changeVersion - b.changeVersion);
    expect(rows.map((r) => r.changeVersion)).toEqual([1, 2]);
    expect(eventVersion()).toBe(2);
  });
});

describe("update_event → syndication outbox", () => {
  beforeEach(seed);

  it("writes one event outbox row + bumps the event when a mirrored field changes", async () => {
    await server.invoke("update_event", { event_id: EVENT_ID, name: "Gray Blueberry Fest" });
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("event");
    expect(rows[0].entityId).toBe(EVENT_ID);
    expect(JSON.parse(rows[0].changedFields)).toContain("name");
    expect(eventVersion()).toBe(1);
  });

  it("writes nothing for a non-mirrored event edit (e.g. description)", async () => {
    await server.invoke("update_event", { event_id: EVENT_ID, description: "New blurb" });
    expect(outboxRows()).toHaveLength(0);
    expect(eventVersion()).toBe(0);
  });
});

describe("update_event_day → syndication outbox", () => {
  beforeEach(() => {
    seed();
    db.insert(eventDays).values({ id: "day-1", eventId: EVENT_ID, date: "2026-08-15" }).run();
  });

  it("fans out on a date change (event_day row keyed by day id, parent event bumped)", async () => {
    await server.invoke("update_event_day", {
      day_id: "day-1",
      date: "2026-08-17",
    });
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("event_day");
    expect(rows[0].entityId).toBe("day-1");
    expect(eventVersion()).toBe(1);
  });

  it("writes nothing for an image-only day edit", async () => {
    await server.invoke("update_event_day", {
      day_id: "day-1",
      image_url: "https://cdn.example/x.jpg",
    });
    expect(outboxRows()).toHaveLength(0);
    expect(eventVersion()).toBe(0);
  });
});
