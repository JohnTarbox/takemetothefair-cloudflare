/**
 * OPE-505 — `create_event_citation` must not move the date it is documenting.
 *
 * Reported from prod on 2026-08-20 against `new-gloucester-community-fair-2026`:
 * `update_event` correctly set start and end to `2026-09-12T12:00:00Z`, then a
 * citation of `start_date: "2026-09-12"` pulled start back to `00:00:00Z` and
 * left end at noon — a split anchor on a single-day event, announced only as
 * `event_column_updated: "startDate"`.
 *
 * Midnight UTC renders as the PREVIOUS calendar day in every US timezone, so
 * this shipped a fair as happening a day early. Citing a value is the last step
 * of verifying it, which means the bug preferentially hit records someone had
 * just taken care to get right.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters } from "../src/schema.js";
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

function parseJson(result: unknown) {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

const EVENT_ID = "4fde2cf7-9298-4b8d-b32f-36b79c376ad0";

function seedEvent(over: Partial<typeof events.$inferInsert> = {}) {
  db.insert(promoters)
    .values({ id: "p-1", companyName: "New Gloucester Fair Assoc", slug: "ng-fair" })
    .onConflictDoNothing()
    .run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "New Gloucester Community Fair",
      slug: "new-gloucester-community-fair-2026",
      promoterId: "p-1",
      status: "APPROVED",
      ...over,
    })
    .run();
}

/** Read the stored column back from the DB, never from the tool's own echo. */
function readDates() {
  const row = db
    .select({ startDate: events.startDate, endDate: events.endDate })
    .from(events)
    .where(eq(events.id, EVENT_ID))
    .get();
  return {
    start: row?.startDate ? new Date(row.startDate as unknown as Date).toISOString() : null,
    end: row?.endDate ? new Date(row.endDate as unknown as Date).toISOString() : null,
  };
}

async function cite(over: Record<string, unknown> = {}) {
  return parseJson(
    await server.invoke("create_event_citation", {
      event_id: EVENT_ID,
      field_name: "start_date",
      value: "2026-09-12",
      source_url: "https://newgloucesterfair.org/",
      source_type: "official_website",
      ...over,
    })
  );
}

describe("create_event_citation — noon anchor (OPE-505)", () => {
  it("REGRESSION: citing a date right after a correct noon write leaves it at noon", async () => {
    // The exact reported ordering. This is the acceptance case.
    seedEvent({
      startDate: new Date("2026-09-12T12:00:00Z"),
      endDate: new Date("2026-09-12T12:00:00Z"),
    });

    await cite();

    const after = readDates();
    expect(after.start).toBe("2026-09-12T12:00:00.000Z");
    // …and the sibling column is untouched, so no split anchor.
    expect(after.end).toBe("2026-09-12T12:00:00.000Z");
  });

  it("anchors a bare YYYY-MM-DD at noon even when the column started empty", async () => {
    seedEvent();
    await cite();
    expect(readDates().start).toBe("2026-09-12T12:00:00.000Z");
  });

  it("preserves an explicit time verbatim — a timed event is not a date-only ingest", async () => {
    seedEvent();
    await cite({ value: "2026-09-12T14:00:00Z" });
    expect(readDates().start).toBe("2026-09-12T14:00:00.000Z");
  });

  it("normalizes an explicit midnight-UTC string too — that is the symptom, not an intent", async () => {
    seedEvent();
    await cite({ value: "2026-09-12T00:00:00Z" });
    expect(readDates().start).toBe("2026-09-12T12:00:00.000Z");
  });

  it("end_date takes the same path", async () => {
    seedEvent();
    await cite({ field_name: "end_date", value: "2026-09-13" });
    expect(readDates().end).toBe("2026-09-13T12:00:00.000Z");
  });

  it("application_deadline takes the same path — a deadline a day early is open-vs-closed", async () => {
    // No prior coverage; found because a mis-aimed mutation landed here and
    // nothing failed. A deadline stored at midnight UTC reads as the previous
    // day to every US visitor.
    seedEvent();
    await cite({ field_name: "application_deadline", value: "2026-08-15" });
    const row = db
      .select({ d: events.applicationDeadline })
      .from(events)
      .where(eq(events.id, EVENT_ID))
      .get();
    expect(new Date(row!.d as unknown as Date).toISOString()).toBe("2026-08-15T12:00:00.000Z");
  });

  it("reports before/after, not a bare column name", async () => {
    seedEvent({ startDate: new Date("2026-08-01T12:00:00Z") });
    const res = await cite();
    expect(res.event_column_updated).toBe("startDate");
    expect(res.column_previous_value).toBe("2026-08-01T12:00:00.000Z");
    expect(res.column_new_value).toBe("2026-09-12T12:00:00.000Z");
  });

  it("skips the write when the value is already correct, so updated_at is not bumped", async () => {
    // updated_at is a real change signal here (conditional GET, sitemap lastmod).
    seedEvent({ startDate: new Date("2026-09-12T12:00:00Z") });
    const before = db
      .select({ u: events.updatedAt })
      .from(events)
      .where(eq(events.id, EVENT_ID))
      .get();

    const res = await cite();
    expect(res.column_skip_reason).toBe("unchanged");
    expect(res.event_column_updated).toBeNull();
    // Still reports the value, so "already correct" is distinguishable from
    // "not attempted".
    expect(res.column_new_value).toBe("2026-09-12T12:00:00.000Z");

    const after = db
      .select({ u: events.updatedAt })
      .from(events)
      .where(eq(events.id, EVENT_ID))
      .get();
    expect(after?.u).toEqual(before?.u);
  });

  it("update_event_column:false still records the citation and touches nothing", async () => {
    seedEvent({ startDate: new Date("2026-09-12T12:00:00Z") });
    const res = await cite({ value: "2026-10-01", update_event_column: false });
    expect(res.ok).toBe(true);
    expect(res.event_column_updated).toBeNull();
    expect(readDates().start).toBe("2026-09-12T12:00:00.000Z");
  });
});

describe("bulk_create_event_citations — same writer (OPE-505)", () => {
  it("bulk path anchors at noon too — the fix is not wired into only one of the two", async () => {
    // Both tools had their own copy of this write. A fix applied to one and not
    // the other is this repo's most-repeated defect shape.
    seedEvent({
      startDate: new Date("2026-09-12T12:00:00Z"),
      endDate: new Date("2026-09-12T12:00:00Z"),
    });

    const res = parseJson(
      await server.invoke("bulk_create_event_citations", {
        citations: [
          {
            event_id: EVENT_ID,
            field_name: "start_date",
            value: "2026-09-12",
            source_url: "https://newgloucesterfair.org/",
            source_type: "official_website",
          },
        ],
      })
    );

    expect(res.errors ?? []).toHaveLength(0);
    expect(readDates().start).toBe("2026-09-12T12:00:00.000Z");
  });

  it("bulk path reports before/after per row", async () => {
    seedEvent({ startDate: new Date("2026-08-01T12:00:00Z") });
    const res = parseJson(
      await server.invoke("bulk_create_event_citations", {
        citations: [
          {
            event_id: EVENT_ID,
            field_name: "start_date",
            value: "2026-09-12",
            source_url: "https://newgloucesterfair.org/",
            source_type: "official_website",
          },
        ],
      })
    );
    expect(res.created[0].column_previous_value).toBe("2026-08-01T12:00:00.000Z");
    expect(res.created[0].column_new_value).toBe("2026-09-12T12:00:00.000Z");
  });
});
