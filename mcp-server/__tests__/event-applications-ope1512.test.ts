/**
 * OPE-1512 — upsert_event_application (the first event_applications writer),
 * list_open_vendor_calls (the digest feed), and the admin read showing both.
 *
 * The round-trip case is the acceptance clause: a patch that names one field
 * must leave every other vendor-application field exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { buildApplicationPatch, closingInstant } from "@takemetothefair/utils";
import { registerEventApplicationTools } from "../src/tools/admin-event-applications.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const NOW = new Date("2026-10-20T16:00:00Z");
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

type Result = { content: Array<{ text: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as Result;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.content[0].text);
  } catch {
    body = { raw: r.content[0].text };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: !!r.isError, body: body as any };
};

const event = (
  id: string,
  opts: { start: string; end: string; status?: string; merged?: string }
) =>
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, merged_into, vendor_fee_min_cents, vendor_fee_max_cents)
       VALUES (?, ?, ?, 'p1', ?, ?, ?, ?, 7500, 12000)`
    )
    .run(
      id,
      `Fair ${id}`,
      `fair-${id}`,
      T(opts.start),
      T(opts.end),
      opts.status ?? "APPROVED",
      opts.merged ?? null
    );

const appRows = () =>
  raw.prepare("SELECT * FROM event_applications ORDER BY created_at").all() as Array<
    Record<string, unknown>
  >;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'a@t', 'ADMIN')").run();
  server = new CapturingMcpServer();
  registerEventApplicationTools(server as never, db, ADMIN);
});
afterEach(() => vi.useRealTimers());

describe("admin only", () => {
  it("registers nothing for a non-admin caller, both tools for an admin", () => {
    const s = new CapturingMcpServer();
    registerEventApplicationTools(s as never, db, { userId: "u", role: "USER" as never });
    expect(s.handlers.size).toBe(0);
    expect([...server.handlers.keys()].sort()).toEqual([
      "list_open_vendor_calls",
      "upsert_event_application",
    ]);
  });
});

describe("upsert_event_application", () => {
  beforeEach(() => event("e1", { start: "2026-11-14T16:00:00Z", end: "2026-11-15T16:00:00Z" }));

  it("creates the whole commercial_vendor lane row, stamps as_of dates, and audits", async () => {
    const r = await call("upsert_event_application", {
      event_id: "e1",
      url: "https://fair.example/vendors",
      closes_on: "2026-11-01",
      capacity_status: "OPEN",
      categories_wanted: [" Pottery ", "woodworking", "POTTERY", "Soap &amp; candles"],
      categories_full: ["Jewelry"],
      reason: "organizer email 10-20",
    });
    expect(r.isError).toBe(false);
    expect(r.body.created).toBe(true);
    expect(r.body.after).toMatchObject({
      lane: "commercial_vendor",
      department: null,
      url: "https://fair.example/vendors",
      closes_on: "2026-11-01",
      capacity_status: "OPEN",
      capacity_as_of: "2026-10-20",
      categories_wanted: ["Pottery", "woodworking", "Soap & candles"],
      categories_full: ["Jewelry"],
      categories_as_of: "2026-10-20",
    });
    // Stored per the OPE-750 closes_at contract: the closing day, 23:59:59 ET.
    // 2026-11-01 is the day DST ends, so that is 23:59:59 EST = 04:59:59Z.
    const [row] = appRows();
    expect(row.closes_at).toBe(T("2026-11-02T04:59:59Z"));
    const audit = raw
      .prepare("SELECT action, target_id, payload_json FROM admin_actions")
      .all() as Array<{ action: string; target_id: string; payload_json: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("event_application.upsert");
    expect(audit[0].target_id).toBe(row.id);
    expect(JSON.parse(audit[0].payload_json)).toMatchObject({
      created: true,
      reason: "organizer email 10-20",
    });
  });

  it("ROUND-TRIP: a one-field patch leaves every other field exactly as it was", async () => {
    await call("upsert_event_application", {
      event_id: "e1",
      url: "https://fair.example/vendors",
      contact_email: "vendors@fair.example",
      notes: "Juried. Tables 6ft.",
      opens_on: "2026-09-01",
      closes_on: "2026-11-01",
      capacity_status: "OPEN",
      capacity_note: "craft hall only",
      categories_wanted: ["Pottery"],
      categories_full: ["Jewelry"],
      categories_as_of: "2026-10-18",
    });
    const before = appRows()[0];
    const r = await call("upsert_event_application", {
      event_id: "e1",
      categories_full: ["Jewelry", "Candles"],
    });
    expect(r.body.created).toBe(false);
    expect(r.body.fields_written.sort()).toEqual(["categoriesAsOf", "categoriesFull"]);
    const after = appRows()[0];
    expect(appRows()).toHaveLength(1);
    for (const col of Object.keys(before)) {
      if (["categories_full", "categories_as_of", "updated_at"].includes(col)) continue;
      expect([col, after[col]]).toEqual([col, before[col]]);
    }
    expect(after.categories_full).toBe('["Jewelry","Candles"]');
    // The as-of follows the newest claim — today, since none was passed.
    expect(r.body.after.categories_as_of).toBe("2026-10-20");
    expect(r.body.before.categories_as_of).toBe("2026-10-18");
  });

  it("null clears; clearing both lists clears categories_as_of; UNKNOWN clears capacity_as_of", async () => {
    await call("upsert_event_application", {
      event_id: "e1",
      capacity_status: "FULL",
      categories_wanted: ["Pottery"],
    });
    const r = await call("upsert_event_application", {
      event_id: "e1",
      capacity_status: "UNKNOWN",
      categories_wanted: [],
      url: null,
    });
    expect(r.body.after).toMatchObject({
      capacity_status: "UNKNOWN",
      capacity_as_of: null,
      categories_wanted: [],
      categories_as_of: null,
      url: null,
    });
    expect(appRows()[0].categories_wanted).toBeNull();
  });

  it("a department row is separate from the whole-lane row", async () => {
    await call("upsert_event_application", { event_id: "e1", capacity_status: "OPEN" });
    await call("upsert_event_application", {
      event_id: "e1",
      department: "Food Court",
      capacity_status: "FULL",
    });
    const rows = appRows();
    expect(rows.map((r) => [r.department, r.capacity_status])).toEqual([
      [null, "OPEN"],
      ["Food Court", "FULL"],
    ]);
  });

  it("refuses — writing nothing — a tombstone, a missing event, a bad date, a non-http URL, an empty patch", async () => {
    event("dup", { start: "2026-11-14T16:00:00Z", end: "2026-11-15T16:00:00Z", merged: "e1" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ event_id: "dup", capacity_status: "OPEN" }, "event_is_merge_tombstone"],
      [{ event_id: "nope", capacity_status: "OPEN" }, "event_not_found"],
      [{ event_id: "e1", closes_on: "2026-02-30" }, "not a real calendar date"],
      [{ event_id: "e1" }, "nothing_to_write"],
      [{ event_id: "e1", categories_wanted: ["x".repeat(61)] }, "max 60"],
    ];
    for (const [args, needle] of cases) {
      const r = await call("upsert_event_application", args);
      expect(r.isError, needle).toBe(true);
      expect(JSON.stringify(r.body)).toContain(needle);
    }
    const bad = await call("upsert_event_application", {
      event_id: "e1",
      url: "javascript:alert(1)",
    });
    expect(bad.isError).toBe(true);
    expect(appRows()).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM admin_actions").get()).toEqual({ n: 0 });
  });
});

describe("list_open_vendor_calls", () => {
  const seed = (
    id: string,
    capacity: string,
    closes: string | null,
    eventEnd = "2026-12-01T16:00:00Z",
    wanted: string | null = '["Pottery"]',
    status = "APPROVED"
  ) => {
    event(id, { start: "2026-11-30T16:00:00Z", end: eventEnd, status });
    raw
      .prepare(
        `INSERT INTO event_applications (id, event_id, lane, capacity_status, closes_at, categories_wanted, created_at, updated_at)
         VALUES (?, ?, 'commercial_vendor', ?, ?, ?, 0, 0)`
      )
      .run(`a-${id}`, id, capacity, closes ? T(closes) : null, wanted);
  };

  it("lists only OPEN, not-closed, live, upcoming calls — soonest deadline first, undated last", async () => {
    seed("later", "OPEN", "2026-11-10T04:59:59Z");
    seed("sooner", "OPEN", "2026-10-25T03:59:59Z");
    seed("undated", "OPEN", null);
    // Closes TODAY (Oct 20 ET): still current until the day has passed.
    seed("today", "OPEN", "2026-10-21T03:59:59Z");
    seed("closed-yesterday", "OPEN", "2026-10-20T03:59:59Z");
    seed("unknown", "UNKNOWN", "2026-11-10T04:59:59Z");
    seed("waitlist", "WAITLIST", "2026-11-10T04:59:59Z");
    seed("full", "FULL", null);
    seed("ended", "OPEN", null, "2026-10-01T16:00:00Z");
    seed("pending", "OPEN", null, undefined, '["x"]', "PENDING");

    const r = await call("list_open_vendor_calls", {});
    expect(r.body.calls.map((c: { event: { id: string } }) => c.event.id)).toEqual([
      "today",
      "sooner",
      "later",
      "undated",
    ]);
    // Landmark: the gate examined the OPEN rows SQL found — the closed-yesterday
    // row reached the calendar check and was dropped there, not missed.
    expect(r.body.open_rows_examined).toBe(5);
    expect(r.body.calls[0]).toMatchObject({
      application: { closes_on: "2026-10-20", categories_wanted: ["Pottery"] },
      booth_fee: { min_cents: 7500, max_cents: 12000 },
    });
  });

  it("with_categories_only drops calls that name no wanted category", async () => {
    seed("with", "OPEN", null);
    seed("without", "OPEN", null, undefined, null);
    const all = await call("list_open_vendor_calls", {});
    const only = await call("list_open_vendor_calls", { with_categories_only: true });
    expect(all.body.count).toBe(2);
    expect(only.body.calls.map((c: { event: { id: string } }) => c.event.id)).toEqual(["with"]);
  });
});

describe("buildApplicationPatch (pure)", () => {
  it("an omitted field never appears in the patch", () => {
    const { patch } = buildApplicationPatch({ notes: "x" }, null, NOW);
    expect(Object.keys(patch)).toEqual(["notes"]);
  });
  it("closingInstant is the OPE-750 convention in both EDT and EST", () => {
    expect(closingInstant("2026-09-14")?.toISOString()).toBe("2026-09-15T03:59:59.000Z");
    expect(closingInstant("2026-12-01")?.toISOString()).toBe("2026-12-02T04:59:59.000Z");
  });
});
