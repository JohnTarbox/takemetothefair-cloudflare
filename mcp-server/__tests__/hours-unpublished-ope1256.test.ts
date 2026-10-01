/**
 * OPE-1256 (OPE-767 option D) — harmony-free-fair's 4 days have NULL hours
 * because the organizer publishes none, so the missing-hours review reason
 * could never clear. `hours_unpublished` records the settled finding; both
 * sides are pinned: the marker clears the reason and the next writer pass does
 * not re-raise it, while a NULL day with no marker still raises.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDays, events, promoters } from "../src/schema.js";
import { eventReviewFlags, dayHoursUnknown } from "@takemetothefair/db-schema";

const NOTES =
  "Organizer page (harmonyfreefair.com) lists dates and attractions, no gate hours. Checked 2026-09-30 and 2026-10-01.";
let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

const call = async (tool: string, args: Record<string, unknown>) =>
  (await server.invoke(tool, args)) as { content: Array<{ text: string }>; isError?: boolean };
const activeMissingHours = (eventId: string) =>
  db
    .select()
    .from(eventReviewFlags)
    .where(
      and(
        eq(eventReviewFlags.eventId, eventId),
        eq(eventReviewFlags.reason, "missing_hours"),
        isNull(eventReviewFlags.clearedAt)
      )
    )
    .all().length;

beforeEach(async () => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(
    server as never,
    db,
    { userId: "u-admin", role: "ADMIN" } as never,
    {
      MAIN_APP_URL: "https://meetmeatthefair.com",
      INTERNAL_API_KEY: "k",
    } as never
  );
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: "p" } as never)
    .run();
  db.insert(events)
    .values({
      id: "harmony",
      name: "Harmony Free Fair",
      slug: "harmony-free-fair",
      promoterId: "p1",
      status: "APPROVED",
    } as never)
    .run();
  for (const d of ["2026-08-27", "2026-08-28"]) {
    const r = await call("create_event_day", { event_id: "harmony", date: d });
    expect(r.isError).toBeFalsy();
  }
});
afterEach(() => mock.restore());

describe("OPE-1256 — hours_unpublished", () => {
  it("a NULL-hours day with no marker raises missing_hours (the research gap)", () => {
    expect(activeMissingHours("harmony")).toBe(1);
  });

  it("marking every day hours_unpublished clears the reason, and a later write does not re-raise it", async () => {
    const days = db.select().from(eventDays).where(eq(eventDays.eventId, "harmony")).all();
    for (const d of days) {
      const r = await call("update_event_day", {
        day_id: d.id,
        hours_unpublished: true,
        internal_notes: NOTES,
      });
      expect(r.isError).toBeFalsy();
    }
    expect(activeMissingHours("harmony")).toBe(0);
    // The next writer pass: an unrelated edit re-derives the axis.
    await call("update_event_day", { day_id: days[0].id, notes: "Parking in the north lot." });
    expect(activeMissingHours("harmony")).toBe(0);
  });

  it("marking only one of two days leaves the reason up", async () => {
    const [d0] = db.select().from(eventDays).where(eq(eventDays.eventId, "harmony")).all();
    await call("update_event_day", {
      day_id: d0.id,
      hours_unpublished: true,
      internal_notes: NOTES,
    });
    expect(activeMissingHours("harmony")).toBe(1);
  });

  it("refuses the marker without provenance, or alongside a time", async () => {
    const [d0] = db.select().from(eventDays).where(eq(eventDays.eventId, "harmony")).all();
    expect(
      (await call("update_event_day", { day_id: d0.id, hours_unpublished: true })).isError
    ).toBe(true);
    const withTime = await call("update_event_day", {
      day_id: d0.id,
      hours_unpublished: true,
      open_time: "09:00",
      internal_notes: NOTES,
    });
    expect(withTime.isError).toBe(true);
  });

  it("a published time later supersedes the marker", async () => {
    const [d0] = db.select().from(eventDays).where(eq(eventDays.eventId, "harmony")).all();
    await call("update_event_day", {
      day_id: d0.id,
      hours_unpublished: true,
      internal_notes: NOTES,
    });
    await call("update_event_day", { day_id: d0.id, open_time: "09:00" });
    const [after] = db.select().from(eventDays).where(eq(eventDays.id, d0.id)).all();
    expect(after.hoursUnpublished).toBe(0);
  });

  it("dayHoursUnknown honours the marker (the per-row twin of the SQL)", () => {
    expect(dayHoursUnknown({ openTime: null, closeTime: null, hoursUnpublished: 1 })).toBe(false);
    expect(dayHoursUnknown({ openTime: null, closeTime: null })).toBe(true);
  });
});
