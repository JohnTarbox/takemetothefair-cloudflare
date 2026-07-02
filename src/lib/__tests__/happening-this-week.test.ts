/**
 * OPE-48 — the "Happening This Week" qualifier must key off an actual
 * `event_days` occurrence within the window, not the event's season span.
 * Exercises `hasOccurrenceInWindowOrUndated` against a real in-memory SQLite
 * DB, mirroring the homepage `getWeekEvents()` WHERE clause.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, gte, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import { events } from "../db/schema";
import { hasOccurrenceInWindowOrUndated, whenWindowEnd, utcDateStr } from "../event-dates";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT,
    start_date INTEGER,
    end_date INTEGER
  );
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    date TEXT NOT NULL,
    closed INTEGER DEFAULT 0
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const sec = (ms: number) => Math.floor(ms / 1000);

function insertEvent(id: string, startMs: number, endMs: number) {
  raw
    .prepare("INSERT INTO events (id, slug, start_date, end_date) VALUES (?,?,?,?)")
    .run(id, id, sec(startMs), sec(endMs));
}
function insertDay(id: string, eventId: string, date: string, closed = 0) {
  raw
    .prepare("INSERT INTO event_days (id, event_id, date, closed) VALUES (?,?,?,?)")
    .run(id, eventId, date, closed);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

describe("hasOccurrenceInWindowOrUndated (OPE-48)", () => {
  // Thu 2026-07-02 → window is [2026-07-02, 2026-07-06) = Thu–Sun (Jul 2–5).
  const now = new Date("2026-07-02T12:00:00Z");
  const horizon = whenWindowEnd("week", now)!;
  const APR11 = Date.UTC(2026, 3, 11, 12);
  const DEC19 = Date.UTC(2026, 11, 19, 12);

  function qualifyingIds(): string[] {
    return db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          gte(events.endDate, now),
          lte(events.startDate, horizon),
          hasOccurrenceInWindowOrUndated(now, horizon)
        )
      )
      .all()
      .map((r) => r.id)
      .sort();
  }

  it("window bounds: today inclusive, Monday exclusive (Sunday is the last day)", () => {
    expect(utcDateStr(now)).toBe("2026-07-02");
    expect(utcDateStr(horizon)).toBe("2026-07-06"); // Monday — the exclusive cap
  });

  it("includes a recurring event with a non-closed occurrence in the window", () => {
    insertEvent("recurring-in", APR11, DEC19);
    insertDay("d1", "recurring-in", "2026-07-04"); // Sat, in window
    expect(qualifyingIds()).toContain("recurring-in");
  });

  it("EXCLUDES a season-long recurring event whose next occurrence is weeks out", () => {
    // The Unity/Juicy bug: Apr→Dec span overlaps the week, but next day is Jul 18.
    insertEvent("recurring-out", APR11, DEC19);
    insertDay("d2", "recurring-out", "2026-07-18");
    expect(qualifyingIds()).not.toContain("recurring-out");
  });

  it("includes a single-day event (no event_days) whose date is in the window", () => {
    const jul4 = Date.UTC(2026, 6, 4, 12);
    insertEvent("single-in", jul4, jul4);
    expect(qualifyingIds()).toContain("single-in");
  });

  it("excludes a single-day event whose date is beyond the window (via span filter)", () => {
    const jul20 = Date.UTC(2026, 6, 20, 12);
    insertEvent("single-out", jul20, jul20);
    expect(qualifyingIds()).not.toContain("single-out");
  });

  it("does NOT count a CLOSED occurrence in the window", () => {
    insertEvent("closed-in", APR11, DEC19);
    insertDay("d3", "closed-in", "2026-07-04", 1); // closed
    insertDay("d4", "closed-in", "2026-07-18"); // next open day is out of window
    expect(qualifyingIds()).not.toContain("closed-in");
  });

  it("boundary: Sunday (last in-window day) qualifies; Monday (cap) does not", () => {
    insertEvent("sun", APR11, DEC19);
    insertDay("d5", "sun", "2026-07-05"); // Sunday — included
    insertEvent("mon", APR11, DEC19);
    insertDay("d6", "mon", "2026-07-06"); // Monday — excluded (== windowEnd)
    const ids = qualifyingIds();
    expect(ids).toContain("sun");
    expect(ids).not.toContain("mon");
  });

  it("end-to-end set: only in-window occurrences + undated-in-window survive", () => {
    insertEvent("recurring-in", APR11, DEC19);
    insertDay("a", "recurring-in", "2026-07-04");
    insertEvent("recurring-out", APR11, DEC19);
    insertDay("b", "recurring-out", "2026-07-18");
    const jul4 = Date.UTC(2026, 6, 4, 12);
    insertEvent("single-in", jul4, jul4);
    const jul20 = Date.UTC(2026, 6, 20, 12);
    insertEvent("single-out", jul20, jul20);
    expect(qualifyingIds()).toEqual(["recurring-in", "single-in"]);
  });
});
