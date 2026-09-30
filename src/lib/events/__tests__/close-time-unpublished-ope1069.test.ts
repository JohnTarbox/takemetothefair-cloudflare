/**
 * OPE-1069 — the SQL half of the hours rule, through the real app writer
 * (`raiseHoursReviewFlag`, used by four of the five event_days writers). The
 * MCP tool uses the per-row twin; both must agree, so both are tested.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { dayHoursUnknown } from "@takemetothefair/db-schema";
import { raiseHoursReviewFlag } from "../hours-review-flag";

let sqlite: Database.Database;
const db = () => drizzle(sqlite, { schema }) as never;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, flagged_for_review INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
    CREATE TABLE event_days (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL,
      open_time TEXT, close_time TEXT,
      close_time_unpublished INTEGER NOT NULL DEFAULT 0
    );
  `);
});

function seed(
  eventId: string,
  days: number,
  row: { open: string | null; close: string | null; unpublished: 0 | 1 }
) {
  sqlite.prepare("INSERT INTO events (id) VALUES (?)").run(eventId);
  const ins = sqlite.prepare(
    "INSERT INTO event_days (id, event_id, date, open_time, close_time, close_time_unpublished) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (let i = 0; i < days; i++) {
    ins.run(
      `${eventId}-${i}`,
      eventId,
      `2026-09-${String(10 + i).padStart(2, "0")}`,
      row.open,
      row.close,
      row.unpublished
    );
  }
}
const flag = (id: string) =>
  (sqlite.prepare("SELECT flagged_for_review f FROM events WHERE id = ?").get(id) as { f: number })
    .f;

describe("raiseHoursReviewFlag — OPE-1069", () => {
  it("The Big E shape: 17 open-only days, close marked unpublished → no flag", async () => {
    seed("big-e", 17, { open: "08:00", close: null, unpublished: 1 });
    const r = await raiseHoursReviewFlag(db(), "big-e");
    // Landmark: 17 days were examined — a zero over an empty set proves nothing.
    expect(r).toEqual({ daysChecked: 17, unknownDays: 0, flagRaised: false });
    expect(flag("big-e")).toBe(0);
  });

  it("the same days WITHOUT the finding are a research gap → flag", async () => {
    seed("gap", 17, { open: "08:00", close: null, unpublished: 0 });
    const r = await raiseHoursReviewFlag(db(), "gap");
    expect(r).toEqual({ daysChecked: 17, unknownDays: 17, flagRaised: true });
    expect(flag("gap")).toBe(1);
  });

  it("an unknown opening time is unknown regardless of the close finding", async () => {
    seed("no-open", 2, { open: null, close: null, unpublished: 1 });
    expect((await raiseHoursReviewFlag(db(), "no-open")).unknownDays).toBe(2);
  });
});

describe("dayHoursUnknown — the per-row twin agrees with the SQL", () => {
  it.each([
    [{ openTime: "08:00", closeTime: null, closeTimeUnpublished: 1 }, false],
    [{ openTime: "08:00", closeTime: null, closeTimeUnpublished: 0 }, true],
    [{ openTime: "08:00", closeTime: "17:00", closeTimeUnpublished: 0 }, false],
    [{ openTime: null, closeTime: null, closeTimeUnpublished: 1 }, true],
  ])("%o → %s", (d, expected) => {
    expect(dayHoursUnknown(d)).toBe(expected);
  });
});
