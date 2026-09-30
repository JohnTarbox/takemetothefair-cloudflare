/**
 * OPE-1078 — a recurring market's hours are stated once and stored once; this
 * tool carries them to the sibling occurrences, with provenance, and refuses
 * every target it cannot justify. Each refusal reason has its own target here,
 * beside targets that DO get written — a guard that refused everything, or
 * nothing, fails.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, eventDays, promoters, venues } from "../src/schema.js";
import { INHERITED_STAMP } from "../src/tools/admin-propagate-hours.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const QUOTE =
  "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026.";
const SRC_NOTES = "PRIMARY: burlingtonfarmersmarket.org, read 2026-09-18.";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

function ev(id: string, date: string, opts: { venue?: string; end?: string } = {}) {
  db.insert(events)
    .values({
      id,
      name: `Burlington Summer Farmers Market ${date}`,
      slug: `burlington-summer-farmers-market-${date}`,
      promoterId: "p1",
      venueId: opts.venue ?? "v-pine",
      status: "APPROVED",
      startDate: new Date(`${date}T12:00:00Z`),
      endDate: new Date(`${opts.end ?? date}T12:00:00Z`),
    } as never)
    .run();
}
function day(eventId: string, date: string, extra: Record<string, unknown> = {}) {
  db.insert(eventDays)
    .values({
      id: `evd_${eventId}_${date}`,
      eventId,
      date,
      openTime: "09:00",
      closeTime: "14:00",
      internalNotes: SRC_NOTES,
      ...extra,
    } as never)
    .run();
}
async function call(args: Record<string, unknown>) {
  const r = (await server.invoke("propagate_recurring_hours", {
    source_day_id: "evd_src_2026-09-19",
    season_start: "2026-05-09",
    season_end: "2026-10-31",
    season_quote: QUOTE,
    ...args,
  })) as { content: Array<{ text: string }>; isError?: boolean };
  return {
    isError: !!r.isError,
    text: r.content[0].text,
    json: r.isError ? null : JSON.parse(r.content[0].text),
  };
}

const TARGETS = ["oct03", "oct10-has", "nov07", "sun", "elsewhere", "multi", "src", "missing"];

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  for (const [id, slug] of [
    ["v-pine", "pine"],
    ["v-winter", "winter"],
  ]) {
    db.insert(venues)
      .values({ id, name: id, slug, address: "a", city: "Burlington", state: "VT", zip: "05401" })
      .run();
  }
  ev("src", "2026-09-19");
  day("src", "2026-09-19", { notes: "PUBLIC note that must never be copied" });
  ev("oct03", "2026-10-03"); // Saturday, in season, same venue, no days → WRITE
  ev("oct10-has", "2026-10-10");
  day("oct10-has", "2026-10-10", { openTime: "10:00", closeTime: "13:00" }); // already houred
  ev("nov07", "2026-11-07"); // Saturday but after the season
  ev("sun", "2026-10-04"); // Sunday
  ev("elsewhere", "2026-10-17", { venue: "v-winter" }); // Saturday, different venue
  ev("multi", "2026-10-24", { end: "2026-10-25" }); // two days
});
afterEach(() => mock.restore());

describe("propagate_recurring_hours — OPE-1078", () => {
  it("dry run plans exactly the justified target and names every refusal", async () => {
    const r = await call({ target_event_ids: TARGETS });
    expect(r.isError).toBe(false);
    expect(r.json.dry_run).toBe(true);
    expect(r.json.planned_rows.map((p: any) => p.event_id)).toEqual(["oct03"]);
    const reasons = Object.fromEntries(r.json.skipped.map((s: any) => [s.event_id, s.reason]));
    expect(reasons).toEqual({
      "oct10-has": "already_has_days",
      nov07: "outside_season",
      sun: "weekday_mismatch",
      elsewhere: "different_venue",
      multi: "multi_day_occurrence",
      src: "is_source_event",
      missing: "event_not_found",
    });
    // Nothing written in a dry run.
    expect(db.select().from(eventDays).where(eq(eventDays.eventId, "oct03")).all()).toHaveLength(0);
    expect(r.json.written).toBe(0);
  });

  it("writes the hours with the provenance stamped, never the public note, and reads it back", async () => {
    const r = await call({ target_event_ids: TARGETS, dry_run: false });
    expect(r.json.written).toBe(1);
    const [d] = db.select().from(eventDays).where(eq(eventDays.eventId, "oct03")).all();
    expect(d.date).toBe("2026-10-03");
    expect([d.openTime, d.closeTime]).toEqual(["09:00", "14:00"]);
    expect(d.notes).toBeNull();
    expect(d.internalNotes).toContain(INHERITED_STAMP);
    expect(d.internalNotes).toContain(QUOTE);
    expect(d.internalNotes).toContain(SRC_NOTES);
    // The already-houred sibling is untouched.
    const [kept] = db.select().from(eventDays).where(eq(eventDays.eventId, "oct10-has")).all();
    expect([kept.openTime, kept.closeTime]).toEqual(["10:00", "13:00"]);
  });

  it("a rerun is a no-op — idempotent", async () => {
    await call({ target_event_ids: TARGETS, dry_run: false });
    const again = await call({ target_event_ids: TARGETS, dry_run: false });
    expect(again.json.written).toBe(0);
    expect(again.json.skipped.find((s: any) => s.event_id === "oct03").reason).toBe(
      "already_has_days"
    );
    expect(db.select().from(eventDays).where(eq(eventDays.eventId, "oct03")).all()).toHaveLength(1);
  });

  it("refuses a source with no provenance, and one with no close time", async () => {
    db.update(eventDays)
      .set({ internalNotes: null })
      .where(eq(eventDays.id, "evd_src_2026-09-19"))
      .run();
    expect((await call({ target_event_ids: ["oct03"] })).text).toMatch(
      /no internal_notes provenance/
    );
    db.update(eventDays)
      .set({ internalNotes: SRC_NOTES, closeTime: null })
      .where(eq(eventDays.id, "evd_src_2026-09-19"))
      .run();
    const r = await call({ target_event_ids: ["oct03"], dry_run: false });
    expect(r.isError).toBe(true);
    expect(db.select().from(eventDays).where(eq(eventDays.eventId, "oct03")).all()).toHaveLength(0);
  });

  it("refuses a season that does not contain its own source day", async () => {
    const r = await call({ target_event_ids: ["oct03"], season_start: "2026-10-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outside the stated season/);
  });
});
