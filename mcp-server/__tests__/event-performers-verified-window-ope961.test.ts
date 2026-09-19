/**
 * OPE-961 — a re-verification pass can read back its own stamps, and the
 * zero-tolerance window check needs one list_event_performers call, not N+1.
 *
 * Fixtures are the two live cases from the ticket: an Oxford stamp against the
 * full-schedule page, and orono-arts-fest's 4:00PM finale against an end_date
 * truncated to noon of the last day (8h outside — inside the health report's
 * ±2d grace, so invisible there).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { performers, eventPerformers, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const OXFORD_SOURCE = "https://www.oxfordcountyfair.com/full-schedule";
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let db: TestDb;
let server: CapturingMcpServer;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await server.invoke(name, args)) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, any>;
};

function seedEvent(id: string, start: string, end: string) {
  db.insert(events)
    .values({
      id,
      name: id,
      slug: id,
      promoterId: "p1",
      status: "APPROVED",
      startDate: new Date(start),
      endDate: new Date(end),
    } as never)
    .run();
}
function seedAppearance(id: string, eventId: string, start: string | null, end?: string) {
  db.insert(eventPerformers)
    .values({
      id,
      eventId,
      performerId: "perf1",
      performanceStart: start ? new Date(start) : null,
      performanceEnd: end ? new Date(end) : null,
      status: "PENDING",
      sourceUrl: OXFORD_SOURCE,
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(performers).values({ id: "perf1", name: "The Finale Band", slug: "finale" }).run();
});

describe("OPE-961 — last_verified_* is readable", () => {
  it("ACCEPTANCE: after set_event_performer_status, list_event_performers shows the stamp and its source", async () => {
    seedEvent("oxford-county-fair", "2026-09-09T12:00:00Z", "2026-09-12T23:59:59Z");
    seedAppearance("bc8fa5c9", "oxford-county-fair", "2026-09-10T18:00:00Z");

    const before = await call("list_event_performers", { event_id: "oxford-county-fair" });
    expect(before.appearances[0]).toMatchObject({
      last_verified_at: null,
      last_verified_source: null,
    });

    const t0 = Math.floor(Date.now() / 1000);
    const write = await call("set_event_performer_status", {
      event_performer_id: "bc8fa5c9",
      status: "CONFIRMED",
      verified_source: OXFORD_SOURCE,
    });
    // The writer echoes it too, not only the listing.
    expect(write.appearance.last_verified_source).toBe(OXFORD_SOURCE);

    const [row] = (await call("list_event_performers", { event_id: "oxford-county-fair" }))
      .appearances;
    expect(row.last_verified_source).toBe(OXFORD_SOURCE);
    expect(row.last_verified_at).toBeGreaterThanOrEqual(t0);
  });

  it("set_event_performer_slot and _billing echo the fields", async () => {
    seedEvent("oxford-county-fair", "2026-09-09T12:00:00Z", "2026-09-12T23:59:59Z");
    seedAppearance("b5ef51eb", "oxford-county-fair", "2026-09-10T18:00:00Z");
    const slot = await call("set_event_performer_slot", {
      event_performer_id: "b5ef51eb",
      stage: "Grandstand",
      verified_source: OXFORD_SOURCE,
    });
    expect(slot.appearance).toMatchObject({ last_verified_source: OXFORD_SOURCE });
    expect(typeof slot.appearance.last_verified_at).toBe("number");
    const billing = await call("set_event_performer_billing", {
      event_performer_id: "b5ef51eb",
      billing: "HEADLINER",
    });
    expect(billing.appearance).toHaveProperty("last_verified_at");
    expect(billing.appearance.last_verified_source).toBe(OXFORD_SOURCE);
  });
});

describe("OPE-961/OPE-1062 — the event window rides along, and the calendar-day check is one call", () => {
  it("returns the event's name, slug and raw window once at the top level", async () => {
    seedEvent("orono-arts-fest", "2026-06-27T12:00:00Z", "2026-06-28T23:59:59Z");
    const r = await call("list_event_performers", { event_id: "orono-arts-fest" });
    expect(r.event).toEqual({
      name: "orono-arts-fest",
      slug: "orono-arts-fest",
      start_date: "2026-06-27T12:00:00.000Z",
      end_date: "2026-06-28T23:59:59.000Z",
      start_sec: sec("2026-06-27T12:00:00Z"),
      end_sec: sec("2026-06-28T23:59:59Z"),
    });
  });

  it("orono-arts-fest with end 23:59:59Z is clean", async () => {
    seedEvent("orono-arts-fest", "2026-06-27T12:00:00Z", "2026-06-28T23:59:59Z");
    seedAppearance("finale", "orono-arts-fest", "2026-06-28T20:00:00Z", "2026-06-28T21:00:00Z");
    const r = await call("list_event_performers", { event_id: "orono-arts-fest" });
    expect(r.appearances[0].outside_event_window).toBe(false);
    expect(r.outside_event_window_count).toBe(0);
  });

  // OPE-1062 — REVERSED. OPE-961 asserted this case was a hit, reading the
  // noon anchor as a truncated end_date. Noon UTC is the house anchor for a
  // date-only column (normalizeEventDate), so a 4pm finale on the last day is
  // ON the last day — and the old reading flagged 89 of 375 prod appearances,
  // every one of them on its event's final day.
  it("OPE-1062: a finale on the last afternoon against the noon-anchored end_date is NOT outside", async () => {
    seedEvent("orono-noon", "2026-06-27T12:00:00Z", "2026-06-28T12:00:00Z");
    seedAppearance("finale", "orono-noon", "2026-06-28T20:00:00Z");
    const r = await call("list_event_performers", { event_id: "orono-noon" });
    expect(r.appearances[0].outside_event_window).toBe(false);
    expect(r.outside_event_window_count).toBe(0);
  });

  it("OPE-1062 ACCEPTANCE: the Harwich Sunday sets (11:15, 12:15, 1:30 EDT) are inside a Sat–Sun event", async () => {
    seedEvent("harwich", "2026-09-19T12:00:00Z", "2026-09-20T12:00:00Z");
    seedAppearance("fowl", "harwich", "2026-09-20T15:15:00Z");
    seedAppearance("summertown", "harwich", "2026-09-20T16:15:00Z");
    seedAppearance("placeholders", "harwich", "2026-09-20T17:30:00Z");
    seedAppearance("saturday", "harwich", "2026-09-19T18:00:00Z");
    const r = await call("list_event_performers", { event_id: "harwich" });
    expect(r.appearances).toHaveLength(4);
    expect(r.outside_event_window_count).toBe(0);
  });

  it("OPE-1062: still fires on a set genuinely on another date — both edges (v3.8)", async () => {
    seedEvent("edge", "2026-06-27T12:00:00Z", "2026-06-28T12:00:00Z");
    // Fri Jun 26, 8pm EDT — the evening BEFORE the first day.
    seedAppearance("day-before", "edge", "2026-06-27T00:00:00Z");
    // Sat Jun 27, 7:59am EDT — the first day, however early.
    seedAppearance("first-morning", "edge", "2026-06-27T11:59:00Z");
    // Mon Jun 29, 1pm EDT — the day AFTER the last day.
    seedAppearance("day-after", "edge", "2026-06-29T17:00:00Z");
    // Sun 11pm → Mon 12:30am EDT: runs past midnight, still the last night.
    seedAppearance("past-midnight", "edge", "2026-06-29T03:00:00Z", "2026-06-29T04:30:00Z");
    // Starts Sunday, "ends" Tuesday — an end that is a data error.
    seedAppearance("runaway-end", "edge", "2026-06-28T18:00:00Z", "2026-06-30T18:00:00Z");
    const r = await call("list_event_performers", { event_id: "edge" });
    const byId = Object.fromEntries(r.appearances.map((a: any) => [a.id, a.outside_event_window]));
    expect(byId).toEqual({
      "day-before": true,
      "first-morning": false,
      "day-after": true,
      "past-midnight": false,
      "runaway-end": true,
    });
    expect(r.outside_event_window_count).toBe(3);
  });

  it("an appearance with no time is null, not a false clean", async () => {
    seedEvent("untimed", "2026-06-27T12:00:00Z", "2026-06-28T23:59:59Z");
    seedAppearance("tba", "untimed", null);
    const r = await call("list_event_performers", { event_id: "untimed" });
    expect(r.appearances[0].outside_event_window).toBeNull();
  });
});
