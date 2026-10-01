/**
 * OPE-1219 — Peabody International Festival: update_event moved the dates
 * 09-27 → 10-04, then RESCHEDULED to 10-04 recorded previousStartDate == the
 * new date, and the event_days row stayed on 09-27. Driven through the real
 * MCP tools, in that order.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters } from "../src/schema.js";
import { noOpRescheduleReason } from "@takemetothefair/constants";
import { eventDaysOutsideRange } from "../src/events/event-days-range.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "k" };
const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const noon = (d: string) => new Date(`${d}T12:00:00Z`);

describe("noOpRescheduleReason (pure)", () => {
  it("refuses when the new start is the row's current start day and no previous is given", () => {
    expect(
      noOpRescheduleReason({
        currentStartDate: noon("2026-10-04"),
        newStartDate: noon("2026-10-04"),
        previousSupplied: false,
      })
    ).toMatch(/previous_start_date/);
  });
  it("allows a real move, or a same-day call that supplies the true previous date", () => {
    expect(
      noOpRescheduleReason({
        currentStartDate: noon("2026-09-27"),
        newStartDate: noon("2026-10-04"),
        previousSupplied: false,
      })
    ).toBeNull();
    expect(
      noOpRescheduleReason({
        currentStartDate: noon("2026-10-04"),
        newStartDate: noon("2026-10-04"),
        previousSupplied: true,
      })
    ).toBeNull();
    expect(
      noOpRescheduleReason({
        currentStartDate: null,
        newStartDate: noon("2026-10-04"),
        previousSupplied: false,
      })
    ).toBeNull();
  });
});

describe("eventDaysOutsideRange (pure, Eastern calendar days)", () => {
  it("names days outside the range and none inside it", () => {
    expect(
      eventDaysOutsideRange(["2026-09-27", "2026-10-04"], noon("2026-10-04"), noon("2026-10-04"))
    ).toEqual(["2026-09-27"]);
    expect(eventDaysOutsideRange(["2026-10-04"], noon("2026-10-04"), null)).toEqual([]);
  });
  it("uses the Eastern day: 02:00Z on the 5th is still the 4th in New York", () => {
    expect(eventDaysOutsideRange(["2026-10-04"], new Date("2026-10-05T02:00:00Z"), null)).toEqual(
      []
    );
  });
});

describe("OPE-1219 — the Peabody sequence through the real tools", () => {
  let db: TestDb;
  let server: CapturingMcpServer;
  let raw: ReturnType<typeof createTestDb>["raw"];
  let mock: ReturnType<typeof mockIndexNowFetch>;
  beforeEach(() => {
    ({ db, raw } = createTestDb());
    server = new CapturingMcpServer();
    registerAdminTools(server as never, db, ADMIN, ENV as never);
    mock = mockIndexNowFetch();
    db.insert(promoters)
      .values({ id: "p", companyName: "P", slug: "p" } as never)
      .run();
    db.insert(events)
      .values({
        id: "peabody",
        name: "Peabody International Festival 2026",
        slug: "peabody-international-festival-2026",
        promoterId: "p",
        status: "APPROVED",
        lifecycleStatus: "SCHEDULED",
        startDate: noon("2026-09-27"),
        endDate: noon("2026-09-27"),
      } as never)
      .run();
    raw
      .prepare(
        "INSERT INTO event_days (id, event_id, date, open_time, close_time) VALUES ('d1', 'peabody', '2026-09-27', '11:00', '17:00')"
      )
      .run();
  });
  afterEach(() => mock.restore());

  it("update_event warns that the move stranded the event_days row", async () => {
    const out = body(
      await server.invoke("update_event", {
        event_id: "peabody",
        start_date: "2026-10-04",
        end_date: "2026-10-04",
      })
    );
    expect(out.warnings?.event_days_outside_dates).toEqual(["2026-09-27"]);
  });

  it("then RESCHEDULED onto the already-moved date is REFUSED, and the row is untouched", async () => {
    await server.invoke("update_event", {
      event_id: "peabody",
      start_date: "2026-10-04",
      end_date: "2026-10-04",
    });
    const res = body(
      await server.invoke("update_event_lifecycle", {
        event_id: "peabody",
        new_lifecycle: "RESCHEDULED",
        new_start_date: "2026-10-04T12:00:00Z",
        new_end_date: "2026-10-04T12:00:00Z",
      })
    );
    expect(res.error).toBe("noop_reschedule");
    const [row] = db.select().from(events).where(eq(events.id, "peabody")).all();
    expect(row.lifecycleStatus).toBe("SCHEDULED");
    expect(row.previousStartDate).toBeNull();
  });

  it("the same call WITH the true previous date records 09-27 as previous", async () => {
    await server.invoke("update_event", {
      event_id: "peabody",
      start_date: "2026-10-04",
      end_date: "2026-10-04",
    });
    const res = body(
      await server.invoke("update_event_lifecycle", {
        event_id: "peabody",
        new_lifecycle: "RESCHEDULED",
        new_start_date: "2026-10-04T12:00:00Z",
        new_end_date: "2026-10-04T12:00:00Z",
        previous_start_date: "2026-09-27T12:00:00Z",
      })
    );
    expect(res.success).toBe(true);
    const [row] = db.select().from(events).where(eq(events.id, "peabody")).all();
    expect(row.lifecycleStatus).toBe("RESCHEDULED");
    expect(row.previousStartDate?.toISOString()).toBe("2026-09-27T12:00:00.000Z");
    expect(row.startDate?.toISOString()).toBe("2026-10-04T12:00:00.000Z");
  });

  it("an ordinary reschedule (no prior date move) still works and snapshots the old date", async () => {
    const res = body(
      await server.invoke("update_event_lifecycle", {
        event_id: "peabody",
        new_lifecycle: "RESCHEDULED",
        new_start_date: "2026-10-04T12:00:00Z",
        new_end_date: "2026-10-04T12:00:00Z",
      })
    );
    expect(res.success).toBe(true);
    const [row] = db.select().from(events).where(eq(events.id, "peabody")).all();
    expect(row.previousStartDate?.toISOString()).toBe("2026-09-27T12:00:00.000Z");
  });
});
