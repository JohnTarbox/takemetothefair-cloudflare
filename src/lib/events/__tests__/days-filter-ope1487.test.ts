/**
 * OPE-1487 — the /events Days filter, run against a real SQLite.
 *
 * The predicate is SQL (weekday arithmetic, an Eastern DST rule, an event_days
 * vs start/end switch), and the bugs worth guarding are SQL-semantics bugs, so
 * these assert on rows a real engine returns rather than on the SQL text.
 * Every case is named after the acceptance line it pins.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { events } from "../../db/schema";
import {
  daysFilterPredicate,
  easternDateSql,
  easternDateStr,
  parseDaysFilter,
  DAYS_FILTERS,
  type DaysFilter,
} from "../days-filter";

const SCHEMA_SQL = `
  CREATE TABLE events (id TEXT PRIMARY KEY, start_date INTEGER, end_date INTEGER);
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL,
    closed INTEGER DEFAULT 0, vendor_only INTEGER DEFAULT 0
  );
`;

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function seed(id: string, startIso: string | null, endIso: string | null = startIso) {
  sqlite
    .prepare("INSERT INTO events (id, start_date, end_date) VALUES (?, ?, ?)")
    .run(id, startIso ? sec(startIso) : null, endIso ? sec(endIso) : null);
}
function day(eventId: string, date: string, over: { closed?: 1; vendorOnly?: 1 } = {}) {
  sqlite
    .prepare(
      "INSERT INTO event_days (id, event_id, date, closed, vendor_only) VALUES (?, ?, ?, ?, ?)"
    )
    .run(`${eventId}-${date}`, eventId, date, over.closed ?? 0, over.vendorOnly ?? 0);
}
function matching(filter: DaysFilter, clipFrom: string | null = null): string[] {
  return db
    .select({ id: events.id })
    .from(events)
    .where(daysFilterPredicate(filter, clipFrom))
    .all()
    .map((r) => r.id)
    .sort();
}
/** Which of the four filters an event matches. */
function profile(id: string, clipFrom: string | null = null): DaysFilter[] {
  return DAYS_FILTERS.filter((f) => matching(f, clipFrom).includes(id));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
});

describe("acceptance spot-checks (OPE-1487)", () => {
  it("a Wed–Sun fair is excluded from weekday-only and included in weekday-any", () => {
    // 2026-10-21 is a Wednesday. Canonical noon-UTC anchors.
    seed("wed-sun", "2026-10-21T12:00:00Z", "2026-10-25T12:00:00Z");
    expect(profile("wed-sun")).toEqual(["weekday-any", "weekend-any"]);
  });

  it("a Tuesday market occurrence (event_days) is included in weekday-only", () => {
    // Season-long span, but its own day is a Tuesday: the day rows decide.
    seed("tue-market", "2026-05-05T12:00:00Z", "2026-10-27T12:00:00Z");
    day("tue-market", "2026-10-20");
    expect(profile("tue-market")).toEqual(["weekday-only", "weekday-any"]);
  });

  it("a Friday-evening-only event stays a Friday although its UTC timestamp is Saturday", () => {
    // 9pm EDT Friday 2026-10-23 = 01:00Z Saturday.
    seed("fri-eve", "2026-10-24T01:00:00Z", "2026-10-24T03:00:00Z");
    expect(profile("fri-eve")).toEqual(["weekday-only", "weekday-any"]);
  });

  it("a Sat–Sun-only event is excluded from weekday-any (and is weekend-only)", () => {
    seed("sat-sun", "2026-10-24T12:00:00Z", "2026-10-25T12:00:00Z");
    expect(profile("sat-sun")).toEqual(["weekend-only", "weekend-any"]);
  });
});

describe("timezone boundary (Eastern calendar, real DST rule)", () => {
  it("EST (winter): 8pm Friday = 01:00Z Saturday is still Friday", () => {
    seed("fri-est", "2026-12-05T01:00:00Z");
    expect(profile("fri-est")).toEqual(["weekday-only", "weekday-any"]);
  });

  it("converts at the DST edges with the right offset", () => {
    const cases: Array<[string, string]> = [
      // 2026 DST starts Sun 2026-03-08 07:00Z. Before it: EST (−5).
      ["2026-03-08T04:30:00Z", "2026-03-07"], // 23:30 EST Sat
      ["2026-03-08T07:30:00Z", "2026-03-08"], // 03:30 EDT Sun
      ["2026-07-04T03:30:00Z", "2026-07-03"], // 23:30 EDT Fri
      // 2026 DST ends Sun 2026-11-01 06:00Z.
      ["2026-11-01T04:30:00Z", "2026-11-01"], // 00:30 EDT Sun
      ["2026-11-01T05:30:00Z", "2026-11-01"], // 01:30 EDT Sun
      ["2026-11-02T04:30:00Z", "2026-11-01"], // 23:30 EST Sun
    ];
    cases.forEach(([iso], i) => seed(`tz${i}`, iso));
    const got = new Map(
      db
        .select({ id: events.id, d: easternDateSql(events.startDate) })
        .from(events)
        .all()
        .map((r) => [r.id, r.d])
    );
    cases.forEach(([iso, want], i) => {
      expect(got.get(`tz${i}`), iso).toBe(want);
      expect(easternDateStr(new Date(iso)), `Intl agrees for ${iso}`).toBe(want);
    });
  });
});

describe("multi-day straddle", () => {
  it("a Fri–Mon span is in both 'any' sets and neither 'only' set", () => {
    seed("fri-mon", "2026-10-23T12:00:00Z", "2026-10-26T12:00:00Z");
    expect(profile("fri-mon")).toEqual(["weekday-any", "weekend-any"]);
  });

  it("a Mon–Fri span is weekday-only", () => {
    seed("mon-fri", "2026-10-19T12:00:00Z", "2026-10-23T12:00:00Z");
    expect(profile("mon-fri")).toEqual(["weekday-only", "weekday-any"]);
  });

  it("a span of a week or more has both kinds of day", () => {
    seed("ten-days", "2026-10-14T12:00:00Z", "2026-10-23T12:00:00Z");
    expect(profile("ten-days")).toEqual(["weekday-any", "weekend-any"]);
  });

  it("a NULL end date is a single day", () => {
    seed("sun-only", "2026-10-25T12:00:00Z", null);
    expect(profile("sun-only")).toEqual(["weekend-only", "weekend-any"]);
  });
});

describe("which days count", () => {
  it("event_days override the span: closed and vendor-only days are not public days", () => {
    seed("fri-open", "2026-10-23T12:00:00Z", "2026-10-25T12:00:00Z");
    day("fri-open", "2026-10-23");
    day("fri-open", "2026-10-24", { closed: 1 });
    day("fri-open", "2026-10-25", { vendorOnly: 1 });
    expect(profile("fri-open")).toEqual(["weekday-only", "weekday-any"]);
  });

  it("an event whose day rows are all closed matches nothing (it does not fall back to the span)", () => {
    seed("all-closed", "2026-10-24T12:00:00Z", "2026-10-25T12:00:00Z");
    day("all-closed", "2026-10-24", { closed: 1 });
    expect(profile("all-closed")).toEqual([]);
  });

  it("an undated event matches none of the four", () => {
    seed("tbd", null, null);
    expect(profile("tbd")).toEqual([]);
  });

  it("in the upcoming listing, days already past do not count", () => {
    // Today is Saturday 10-24: the Wed–Sun fair has only Sat and Sun left.
    seed("wed-sun", "2026-10-21T12:00:00Z", "2026-10-25T12:00:00Z");
    seed("market", "2026-05-05T12:00:00Z", "2026-10-31T12:00:00Z");
    day("market", "2026-10-20"); // Tue, past
    day("market", "2026-10-31"); // Sat, upcoming
    expect(profile("wed-sun", "2026-10-24")).toEqual(["weekend-only", "weekend-any"]);
    expect(profile("market", "2026-10-24")).toEqual(["weekend-only", "weekend-any"]);
    // With includePast every day counts again.
    expect(profile("market", null)).toEqual(["weekday-any", "weekend-any"]);
  });

  it("an event that has no day left after today matches nothing", () => {
    seed("over", "2026-10-21T12:00:00Z", "2026-10-22T12:00:00Z");
    expect(profile("over", "2026-10-24")).toEqual([]);
  });
});

describe("parseDaysFilter", () => {
  it("accepts the four values and nothing else", () => {
    for (const f of DAYS_FILTERS) expect(parseDaysFilter(f)).toBe(f);
    for (const bad of [undefined, null, "", "any", "weekday", "WEEKDAY-ONLY"])
      expect(parseDaysFilter(bad)).toBeNull();
  });
});
