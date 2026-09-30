/**
 * OPE-960 — the performer sweep's selection surface.
 *
 *   1. list_all_events.performer_roster_status (+ UNSET for the NULL population)
 *      and performer_count / has_performers — the twin of OPE-264's vendor rails.
 *   2. active_from / active_to on list_all_events AND search_events — an
 *      OVERLAP window, so a fair that opened before `now` and is still on is
 *      selectable. start_after cannot express that (the landmark below proves
 *      the old filter misses it on the same data).
 *   3. total_matching, so a sweep can prove coverage.
 *
 * The calendar is the ticket's: `now` inside Sep 11–13 2026, Litchfield Fair
 * running Sep 11–14, the sweep window [Sep 12, Sep 19].
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerPublicTools } from "../src/tools/public.js";
import { eventPerformers, events, performers, promoters, users } from "../src/schema.js";
import { parseWindowBound } from "../src/tools/event-window.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let admin: CapturingMcpServer;
let pub: CapturingMcpServer;

/** Midnight UTC of a September 2026 day. */
const sep = (d: number, hour = 0) => new Date(Date.UTC(2026, 8, d, hour));

function seedEvent(o: {
  id: string;
  start: Date | null;
  end?: Date | null;
  performerRosterStatus?: "NEEDS_RESEARCH" | "VERIFIED" | "NO_LINEUP_PUBLISHED" | null;
  categories?: string[];
}) {
  db.insert(events)
    .values({
      id: o.id,
      name: `Event ${o.id}`,
      slug: o.id,
      promoterId: "p-1",
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      startDate: o.start,
      endDate: o.end ?? null,
      performerRosterStatus: o.performerRosterStatus ?? null,
      categories: JSON.stringify(o.categories ?? ["Fair"]),
    } as never)
    .run();
}

let perfSeq = 0;
function addAppearances(eventId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const pid = `perf-${++perfSeq}`;
    db.insert(performers)
      .values({ id: pid, name: `Act ${pid}`, slug: pid } as never)
      .run();
    db.insert(eventPerformers)
      .values({ id: `ep-${pid}`, eventId, performerId: pid, status: "CONFIRMED" } as never)
      .run();
  }
}

type Row = {
  id: string;
  performer_count?: number;
  performer_roster_status?: string | null;
};
type ListResult = {
  count: number;
  offset: number;
  total_matching: number | null;
  total_matching_unavailable?: string;
  has_more: boolean;
  events: Row[];
  error?: string;
};

async function call(server: CapturingMcpServer, tool: string, args: Record<string, unknown>) {
  const r = (await server.invoke(tool, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { ...(JSON.parse(r.content[0].text) as ListResult), isError: r.isError === true };
}
const listAll = (a: Record<string, unknown>) => call(admin, "list_all_events", a);
const search = (a: Record<string, unknown>) => call(pub, "search_events", a);
const ids = (r: ListResult) => r.events.map((e) => e.id).sort();

beforeEach(() => {
  ({ db } = createTestDb());
  admin = new CapturingMcpServer();
  pub = new CapturingMcpServer();
  registerAdminTools(admin as never, db, ADMIN_AUTH, ENV as never);
  registerPublicTools(pub as never, db);
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" } as never)
    .run();
});

describe("OPE-960 scope 2 — overlap window", () => {
  beforeEach(() => {
    // Mixed end-of-day conventions (noon UTC per drizzle/0074; 23:59:59Z on prod rows).
    seedEvent({ id: "litchfield-fair", start: sep(11), end: sep(14, 12) }); // running at `now`
    seedEvent({ id: "closes-on-from", start: sep(8), end: sep(12, 12) }); // boundary, lower
    seedEvent({ id: "opens-on-to", start: sep(19, 14), end: sep(21, 12) }); // boundary, upper — opens mid-day on `to`
    seedEvent({ id: "single-day-no-end", start: sep(15) });
    seedEvent({ id: "ended-before", start: sep(5), end: sep(10, 12) }); // decoy
    seedEvent({ id: "starts-after", start: sep(25), end: sep(27, 12) }); // decoy
    seedEvent({ id: "undated", start: null }); // decoy — nothing to overlap
  });

  const IN_WINDOW = ["closes-on-from", "litchfield-fair", "opens-on-to", "single-day-no-end"];

  it("LANDMARK (the defect): start_after misses the fair that is running now", async () => {
    const r = await search({ start_after: "2026-09-12", start_before: "2026-09-19" });
    expect(ids(r)).toContain("single-day-no-end"); // the filter works…
    expect(ids(r)).not.toContain("litchfield-fair"); // …and is blind to a running fair
  });

  it("list_all_events: returns exactly what is ON in [Sep 12, Sep 19], litchfield-fair included", async () => {
    const r = await listAll({ active_from: "2026-09-12", active_to: "2026-09-19", limit: 100 });
    expect(r.isError).toBe(false);
    expect(ids(r)).toEqual(IN_WINDOW);
  });

  it("search_events: the same window, the same set", async () => {
    const r = await search({ active_from: "2026-09-12", active_to: "2026-09-19", limit: 50 });
    expect(ids(r)).toEqual(IN_WINDOW);
  });

  it("each bound works alone", async () => {
    expect(ids(await listAll({ active_from: "2026-09-12", limit: 100 }))).toEqual(
      [...IN_WINDOW, "starts-after"].sort()
    );
    expect(ids(await listAll({ active_to: "2026-09-19", limit: 100 }))).toEqual(
      [...IN_WINDOW, "ended-before"].sort()
    );
  });

  it("a full ISO timestamp is used as given, not widened to the day", async () => {
    // closes-on-from ends at 12:00Z on Sep 12; a bound of 13:00Z excludes it.
    const r = await listAll({
      active_from: "2026-09-12T13:00:00Z",
      active_to: "2026-09-19",
      limit: 100,
    });
    expect(ids(r)).not.toContain("closes-on-from");
    expect(ids(r)).toContain("litchfield-fair");
  });

  it.each([
    [{ active_from: "not-a-date" }, /active_from/],
    [{ active_to: "2026-02-31" }, /active_to/], // rolls over in JS; refused here
    [{ active_from: "2026-09-19", active_to: "2026-09-12" }, /empty/],
  ])("refuses a bad window %j — an ERROR, never a silently dropped filter", async (args, msg) => {
    for (const r of [await listAll(args), await search(args)]) {
      expect(r.isError).toBe(true);
      expect(r.error).toBe("invalid_window");
      expect(JSON.stringify(r)).toMatch(msg);
    }
  });

  it("parseWindowBound widens date-only bounds outward", () => {
    expect(parseWindowBound("2026-09-12", "from")?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(parseWindowBound("2026-09-19", "to")?.toISOString()).toBe("2026-09-19T23:59:59.999Z");
  });
});

describe("OPE-960 scope 1 — performer_roster_status, has_performers, performer_count", () => {
  beforeEach(() => {
    seedEvent({
      id: "needs",
      start: sep(12),
      end: sep(13, 12),
      performerRosterStatus: "NEEDS_RESEARCH",
    });
    seedEvent({
      id: "verified",
      start: sep(12),
      end: sep(13, 12),
      performerRosterStatus: "VERIFIED",
    });
    seedEvent({ id: "unset-a", start: sep(12), end: sep(13, 12) });
    seedEvent({ id: "unset-b", start: sep(12), end: sep(13, 12) });
    addAppearances("verified", 3);
    addAppearances("unset-a", 2);
  });

  it("['NEEDS_RESEARCH'] selects only that status", async () => {
    expect(ids(await listAll({ performer_roster_status: ["NEEDS_RESEARCH"] }))).toEqual(["needs"]);
  });

  it("['UNSET'] selects the NULL population, which a named status never reaches", async () => {
    expect(ids(await listAll({ performer_roster_status: ["UNSET"] }))).toEqual([
      "unset-a",
      "unset-b",
    ]);
  });

  it("['NEEDS_RESEARCH','UNSET'] is the full un-researched worklist (OR)", async () => {
    expect(ids(await listAll({ performer_roster_status: ["NEEDS_RESEARCH", "UNSET"] }))).toEqual([
      "needs",
      "unset-a",
      "unset-b",
    ]);
  });

  it("returns performer_count and performer_roster_status per row", async () => {
    const r = await listAll({ limit: 100 });
    const byId = Object.fromEntries(r.events.map((e) => [e.id, e]));
    expect(byId["verified"]).toMatchObject({
      performer_count: 3,
      performer_roster_status: "VERIFIED",
    });
    expect(byId["unset-a"]).toMatchObject({ performer_count: 2, performer_roster_status: null });
    expect(byId["needs"]).toMatchObject({ performer_count: 0 });
  });

  it("has_performers true/false partitions on the event's OWN appearances", async () => {
    // Pins the correlation: an uncorrelated EXISTS would return all four here.
    expect(ids(await listAll({ has_performers: true }))).toEqual(["unset-a", "verified"]);
    expect(ids(await listAll({ has_performers: false }))).toEqual(["needs", "unset-b"]);
  });

  it("ACCEPTANCE: the in-window lineup set in ONE call", async () => {
    seedEvent({ id: "past-with-lineup", start: sep(1), end: sep(3, 12) });
    addAppearances("past-with-lineup", 4);
    const r = await listAll({
      active_from: "2026-09-12",
      active_to: "2026-09-19",
      has_performers: true,
      limit: 100,
    });
    expect(ids(r)).toEqual(["unset-a", "verified"]);
    expect(r.total_matching).toBe(2);
    expect(r.has_more).toBe(false);
  });
});

describe("OPE-960 scope 3 — total_matching", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++)
      seedEvent({ id: `e${i}`, start: sep(10 + i), end: sep(10 + i, 12) });
  });

  it("list_all_events: total survives paging, and has_more is exact on the last full page", async () => {
    const p1 = await listAll({ limit: 2, sort: "start_date_asc" });
    expect(p1).toMatchObject({ count: 2, total_matching: 5, has_more: true });
    // Old rule was `count === limit`: a final page of exactly `limit` rows said has_more:true.
    const last = await listAll({ limit: 2, offset: 3, sort: "start_date_asc" });
    expect(last).toMatchObject({ count: 2, total_matching: 5, has_more: false });
  });

  it("list_all_events: total respects the filters, not the table", async () => {
    const r = await listAll({ active_from: "2026-09-14", limit: 1 });
    // e4 (ends Sep 14 noon) and e5 (Sep 15) are still on at Sep 14 00:00Z.
    expect(r).toMatchObject({ count: 1, total_matching: 2, has_more: true });
  });

  it("search_events: exact total on the SQL path", async () => {
    const r = await search({ limit: 2 });
    expect(r).toMatchObject({ count: 2, total_matching: 5, has_more: true });
    const last = await search({ limit: 2, offset: 3 });
    expect(last).toMatchObject({ count: 2, total_matching: 5, has_more: false });
  });

  it("search_events: says there is no exact total when JS filters after the fetch", async () => {
    const r = await search({ category: "fair", limit: 2 });
    expect(r.count).toBe(2); // landmark — the path returned rows
    expect(r.total_matching).toBeNull();
    expect(r.total_matching_unavailable).toMatch(/category/);
  });
});
