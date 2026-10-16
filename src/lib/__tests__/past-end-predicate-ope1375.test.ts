/**
 * OPE-1375 — upcoming/past share one day boundary. An event anchored at noon
 * UTC on its last day must still be upcoming (and NOT past) at 14:00 UTC that
 * day — the inline `endDate >= now` dropped it at 12:00Z (08:00 ET) and the
 * inline `endDate < now` called it past at the same instant.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { events } from "../db/schema";
import { isPastEnd, pastEndPredicate, upcomingEndPredicate } from "../event-dates";
import * as shared from "@takemetothefair/db-schema";

const NOW = new Date("2026-10-17T14:00:00Z"); // 10:00 EDT on the last day
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, start_date INTEGER, end_date INTEGER);`);
  const ins = raw.prepare("INSERT INTO events (id, start_date, end_date) VALUES (?, ?, ?)");
  ins.run("ends_today", sec("2026-10-16T12:00:00Z"), sec("2026-10-17T12:00:00Z"));
  ins.run("null_end_today", sec("2026-10-17T12:00:00Z"), null);
  ins.run("null_end_future", sec("2026-10-24T12:00:00Z"), null);
  ins.run("ended_yesterday", sec("2026-10-15T12:00:00Z"), sec("2026-10-16T12:00:00Z"));
  ins.run("null_end_last_week", sec("2026-10-10T12:00:00Z"), null);
  ins.run("future", sec("2026-11-01T12:00:00Z"), sec("2026-11-02T12:00:00Z"));
  ins.run("no_dates", null, null);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

async function ids(where: SQL) {
  const rows = await db.select({ id: events.id }).from(events).where(where);
  return rows.map((r) => r.id).sort();
}

describe("upcomingEndPredicate / pastEndPredicate (OPE-1375)", () => {
  it("an event ending today at the noon-UTC anchor is upcoming at 14:00 UTC, not past", async () => {
    expect(await ids(upcomingEndPredicate(NOW))).toContain("ends_today");
    expect(await ids(pastEndPredicate(NOW))).not.toContain("ends_today");
  });

  it("a NULL end_date event is upcoming per its start date (OPE-1035), not past", async () => {
    const up = await ids(upcomingEndPredicate(NOW));
    expect(up).toContain("null_end_today");
    expect(up).toContain("null_end_future");
    const past = await ids(pastEndPredicate(NOW));
    expect(past).not.toContain("null_end_today");
    expect(past).not.toContain("null_end_future");
  });

  it("past = exact complement of upcoming over every dated row; undated rows in neither", async () => {
    const up = await ids(upcomingEndPredicate(NOW));
    const past = await ids(pastEndPredicate(NOW));
    expect(up).toEqual(["ends_today", "future", "null_end_future", "null_end_today"].sort());
    expect(past).toEqual(["ended_yesterday", "null_end_last_week"]);
    expect(up.filter((id) => past.includes(id))).toEqual([]);
    expect([...up, ...past]).not.toContain("no_dates");
  });

  it("the main-app re-export IS the shared helper the MCP Worker imports (parity by identity)", () => {
    expect(upcomingEndPredicate).toBe(shared.upcomingEndPredicate);
    expect(pastEndPredicate).toBe(shared.pastEndPredicate);
  });
});

describe("OPE-1396 (DUP5) — the in-memory and raw-subquery forms agree with the SQL", () => {
  it("isPastEnd(row, now) matches pastEndPredicate on every row", async () => {
    const rows = raw.prepare("SELECT id, start_date, end_date FROM events").all() as Array<{
      id: string;
      start_date: number | null;
      end_date: number | null;
    }>;
    const toDate = (s: number | null) => (s == null ? null : new Date(s * 1000));
    const jsPast = rows
      .filter((r) =>
        isPastEnd({ startDate: toDate(r.start_date), endDate: toDate(r.end_date) }, NOW)
      )
      .map((r) => r.id)
      .sort();
    expect(jsPast).toEqual(await ids(pastEndPredicate(NOW)));
  });

  it("interpolated into a raw `FROM events` subquery (venue counts), it counts the same rows", () => {
    // The venues listing/export build `(SELECT COUNT(*) FROM events WHERE … AND ${pred})`.
    const q = db
      .select({ n: sql<number>`(SELECT COUNT(*) FROM events WHERE ${upcomingEndPredicate(NOW)})` })
      .from(events)
      .limit(1)
      .toSQL();
    const row = raw
      .prepare(q.sql)
      .raw()
      .get(...(q.params as unknown[])) as number[];
    const n = row[0];
    // ends_today, null_end_today, null_end_future, future — the old raw
    // `end_date >= now` would have counted only `future`.
    expect(n).toBe(4);
  });
});
