/**
 * OPE-1180 — the FORMER-venue date guard on the MCP Worker's event write paths.
 *
 * Venue: the Montpelier trotting park, closed "1881~" → closure window
 * [1880-01-01, 1882-12-31]. Each path is driven through all the outcomes it
 * can produce: allow (pre-closure), flag (inside the window), refuse / drop
 * (after the closure). The drizzle/0333 triggers are loaded into the test DB
 * (setup-db.ts reads the migration), so the last block proves the backstop
 * holds on a write that bypasses every code path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parseEdtfBounds, unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";
import { events, promoters, users, venues } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const at = (d: string) => new Date(`${d}T12:00:00Z`);
const CLOSED = parseEdtfBounds("1881~")!;

let db: TestDb;
let admin: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  admin = new CapturingMcpServer();
  registerAdminTools(admin as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p1", companyName: "Washington County Ag Society", slug: unsafeSlug("wcas") })
    .run();
  db.insert(venues)
    .values({
      id: "v-old",
      name: "Montpelier Trotting Park",
      slug: unsafeSlug("montpelier-trotting-park"),
      address: "",
      city: "Montpelier",
      state: "VT",
      zip: "",
      status: "FORMER",
      useEndedEdtf: "1881~",
      useEndedEarliest: CLOSED.earliest,
      useEndedLatest: CLOSED.latest,
    })
    .run();
  db.insert(venues)
    .values({
      id: "v-live",
      name: "Barre Auditorium",
      slug: unsafeSlug("barre-auditorium"),
      address: "16 Auditorium Hill",
      city: "Barre",
      state: "VT",
      zip: "05641",
    })
    .run();
});
afterEach(() => mock.restore());

function seedEvent(
  id: string,
  venueId: string | null,
  day: string,
  extra: Partial<typeof events.$inferInsert> = {}
) {
  db.insert(events)
    .values({
      id,
      name: `Event ${id}`,
      slug: unsafeSlug(`event-${id}`),
      promoterId: "p1",
      venueId,
      status: "APPROVED",
      startDate: at(day),
      endDate: at(day),
      ...extra,
    })
    .run();
}

const row = (id: string) => db.select().from(events).where(eq(events.id, id)).all()[0];

async function updateEvent(args: Record<string, unknown>) {
  const r = (await admin.invoke("update_event", args)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) as Record<string, any> };
}

describe("update_event", () => {
  it("REFUSE: moving a 2026 event onto the closed venue names the closure", async () => {
    seedEvent("e1", "v-live", "2026-09-27");
    const r = await updateEvent({ event_id: "e1", venue_id: "v-old" });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("former_venue_after_closure");
    expect(r.body.message).toContain("closed 1881~");
    expect(r.body.message).toContain("2026-09-27");
    expect(row("e1").venueId).toBe("v-live");
  });

  it("REFUSE: moving an event already at the closed venue to a post-closure date", async () => {
    seedEvent("e2", "v-old", "1879-09-20");
    const r = await updateEvent({
      event_id: "e2",
      start_date: "2026-09-27",
      end_date: "2026-09-27",
    });
    expect(r.isError).toBe(true);
    expect(row("e2").startDate?.toISOString().slice(0, 10)).toBe("1879-09-20");
  });

  it("FLAG: a date inside the closure window is written and flagged, with a warning", async () => {
    seedEvent("e3", "v-live", "1881-09-20");
    const r = await updateEvent({ event_id: "e3", venue_id: "v-old" });
    expect(r.isError).toBe(false);
    expect(r.body.warnings?.former_venue_flagged).toContain("closure window");
    expect(row("e3").venueId).toBe("v-old");
    expect(row("e3").flaggedForReview).toBe(1);
  });

  it("ALLOW: a pre-closure event at the closed venue is written, unflagged", async () => {
    seedEvent("e4", "v-live", "1879-09-20");
    const r = await updateEvent({ event_id: "e4", venue_id: "v-old" });
    expect(r.isError).toBe(false);
    expect(r.body.warnings?.former_venue_flagged).toBeUndefined();
    expect(row("e4").venueId).toBe("v-old");
    expect(row("e4").flaggedForReview).toBe(0);
  });
});

describe("rollover", () => {
  it("never copies a FORMER venue forward: the next edition has no venue and is flagged", async () => {
    seedEvent("src", "v-old", "1879-09-20", {
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
      lifecycleStatus: "OCCURRED",
    });
    const res = await rolloverEventIfRecurring(db, "src", { now: at("1879-12-01") } as never);
    expect(res.created).toBe(true);
    const next = db
      .select()
      .from(events)
      .where(eq(events.id, (res as { newEventId: string }).newEventId))
      .all()[0];
    expect(next.venueId).toBeNull();
    expect(next.flaggedForReview).toBe(1);
  });

  it("an ACTIVE venue still rolls forward (control)", async () => {
    seedEvent("src2", "v-live", "2026-09-20", {
      recurrenceRule: "FREQ=YEARLY;INTERVAL=1",
      lifecycleStatus: "OCCURRED",
    });
    const res = await rolloverEventIfRecurring(db, "src2", { now: at("2026-11-01") } as never);
    const next = db
      .select()
      .from(events)
      .where(eq(events.id, (res as { newEventId: string }).newEventId))
      .all()[0];
    expect(next.venueId).toBe("v-live");
  });
});

describe("suggest_event — ingest never fails, never attaches after the closure", () => {
  it("a post-closure suggestion matching the closed venue lands WITHOUT a venue, flagged", async () => {
    db.insert(users).values({ id: "u-sub", email: "sub@test", role: "USER" }).run();
    const vendor = new CapturingMcpServer();
    registerVendorTools(vendor as never, db, { userId: "u-sub", role: "USER" } as never, undefined);
    const r = (await vendor.invoke("suggest_event", {
      name: "Stateline Gun Show Montpelier",
      start_date: "2026-11-14",
      end_date: "2026-11-15",
      description: "A gun show.",
      venue_name: "Montpelier Trotting Park",
      venue_city: "Montpelier",
      venue_state: "VT",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeFalsy();
    const [ev] = db
      .select()
      .from(events)
      .where(eq(events.name, "Stateline Gun Show Montpelier"))
      .all();
    expect(ev).toBeDefined();
    expect(ev.venueId).not.toBe("v-old");
    expect(ev.flaggedForReview).toBe(1);
  });
});

describe("the drizzle/0333 trigger backstop", () => {
  it("a raw write that bypasses every code path is still refused", () => {
    seedEvent("raw", "v-live", "2026-09-27");
    expect(() =>
      db.update(events).set({ venueId: "v-old" }).where(eq(events.id, "raw")).run()
    ).toThrow(/FORMER_VENUE_AFTER_CLOSURE/);
  });

  it("…while the same raw write for a pre-closure event succeeds (the landmark)", () => {
    seedEvent("raw2", "v-live", "1879-09-20");
    db.update(events).set({ venueId: "v-old" }).where(eq(events.id, "raw2")).run();
    expect(row("raw2").venueId).toBe("v-old");
  });
});
