/**
 * OPE-1069 — "the organizer publishes no closing time" is a settled finding,
 * not a research gap. Before this, create_event_day raised flagged_for_review
 * for both, and The Big E (17 organizer-sourced days) sat in the review queue
 * looking exactly like an event nobody had researched.
 *
 * Each "does not flag" is paired with a "does flag" on the same shape, so a
 * rule that never flags cannot pass (v3.8 obligation 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, eventDays, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const NOTES =
  "Organizer hours page (thebige.com/fair/hours) lists gate + building hours; no grounds closing time published. Read 2026-09-18.";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

function seedEvent(id: string) {
  db.insert(events)
    .values({ id, name: id, slug: id, promoterId: "p1", status: "APPROVED" } as never)
    .run();
}
const flagged = (id: string) =>
  db.select().from(events).where(eq(events.id, id)).all()[0].flaggedForReview;
const day = (eventId: string, date: string) =>
  db
    .select()
    .from(eventDays)
    .where(eq(eventDays.id, `evd_${eventId}_${date}`))
    .all()[0];
async function create(args: Record<string, unknown>) {
  return (await server.invoke("create_event_day", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  seedEvent("gap");
  seedEvent("big-e");
});
afterEach(() => mock.restore());

describe("create_event_day — the two conditions no longer collapse", () => {
  it("a genuinely unknown close time STILL flags (the research gap)", async () => {
    const r = await create({ event_id: "gap", date: "2026-09-19", open_time: "08:00" });
    expect(r.isError).toBeFalsy();
    expect(day("gap", "2026-09-19")).toBeDefined(); // landmark: the day exists
    expect(flagged("gap")).toBe(1);
  });

  it("a close time the organizer does not publish does NOT flag (the settled finding)", async () => {
    const r = await create({
      event_id: "big-e",
      date: "2026-09-19",
      open_time: "08:00",
      close_time_unpublished: true,
      internal_notes: NOTES,
    });
    expect(r.isError).toBeFalsy();
    const d = day("big-e", "2026-09-19");
    expect(d.closeTime).toBeNull();
    expect(d.closeTimeUnpublished).toBe(1);
    expect(flagged("big-e")).toBe(0);
  });

  it("an unknown OPENING time still flags even when the close is marked unpublished", async () => {
    await create({
      event_id: "big-e",
      date: "2026-09-20",
      close_time_unpublished: true,
      internal_notes: NOTES,
    });
    expect(flagged("big-e")).toBe(1);
  });

  it("refuses unpublished alongside a close_time (a contradiction) and writes nothing", async () => {
    const r = await create({
      event_id: "big-e",
      date: "2026-09-21",
      open_time: "08:00",
      close_time: "22:00",
      close_time_unpublished: true,
      internal_notes: NOTES,
    });
    expect(r.isError).toBe(true);
    expect(day("big-e", "2026-09-21")).toBeUndefined();
  });

  it("refuses unpublished with no provenance note and writes nothing", async () => {
    const r = await create({
      event_id: "big-e",
      date: "2026-09-22",
      open_time: "08:00",
      close_time_unpublished: true,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/internal_notes/);
    expect(day("big-e", "2026-09-22")).toBeUndefined();
  });
});

describe("update_event_day", () => {
  it("marks an existing day unpublished using the provenance already on the row", async () => {
    await create({
      event_id: "gap",
      date: "2026-09-23",
      open_time: "08:00",
      internal_notes: NOTES,
    });
    const r = (await server.invoke("update_event_day", {
      day_id: "evd_gap_2026-09-23",
      close_time_unpublished: true,
    })) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(day("gap", "2026-09-23").closeTimeUnpublished).toBe(1);
  });

  it("refuses the mark on a row with no notes when the call brings none", async () => {
    await create({ event_id: "gap", date: "2026-09-24", open_time: "08:00" });
    const r = (await server.invoke("update_event_day", {
      day_id: "evd_gap_2026-09-24",
      close_time_unpublished: true,
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(day("gap", "2026-09-24").closeTimeUnpublished).toBe(0);
  });

  it("a published close time supersedes the finding", async () => {
    await create({
      event_id: "big-e",
      date: "2026-09-25",
      open_time: "08:00",
      close_time_unpublished: true,
      internal_notes: NOTES,
    });
    await server.invoke("update_event_day", {
      day_id: "evd_big-e_2026-09-25",
      close_time: "21:00",
    });
    const d = day("big-e", "2026-09-25");
    expect(d.closeTime).toBe("21:00");
    expect(d.closeTimeUnpublished).toBe(0);
  });
});
