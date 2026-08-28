/**
 * OPE-598 — the state page's year comes from the events it LISTS, not the clock.
 *
 * The defect: `buildStateTitle` defaulted its year to `new Date().getFullYear()`,
 * so a state page whose remaining inventory was entirely next year was still
 * headed with this year. Late December was the worst case, and the function's
 * own docblock flagged it — "for the last few weeks of the year it advertises a
 * calendar that is nearly spent" — while noting that rolling early on the clock
 * would invert the problem (promising 2027 while listing 2026 events).
 *
 * Deriving the label from the listed events dissolves that dilemma rather than
 * picking a side: the title cannot advertise a year the page does not list,
 * because the label IS the listing.
 *
 * ── What these tests are guarding, and why the shapes are what they are ──
 *
 * OPE-394's approval carried exactly ONE condition: the year must never freeze,
 * so January needs no deploy (the OPE-197 class — ~1,146 series names carrying a
 * hardcoded trailing year took a whole ticket to evergreen). OPE-598 changes
 * where the year comes FROM; it must not change whether one appears. The
 * fallback test below is that condition, and it fails if the fallback is
 * weakened to "".
 *
 * The Eastern-boundary case uses an instant that is 2027 in UTC and 2026 in
 * Eastern. A test written a few hours either side of it passes under a plain
 * `getUTCFullYear()`, which is the mutation it exists to kill — so the instant
 * is the assertion, not decoration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { getUpcomingEventYearSpanByState, formatYearSpanLabel } from "../queries";

/**
 * Only the columns the span query reads. Inserts below go through raw SQL
 * rather than drizzle precisely so this can stay minimal — drizzle names every
 * column of the table on insert, which is what makes a partial CREATE TABLE
 * fail with "no column named location_id" instead of with anything about the
 * behaviour under test.
 */
const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    lifecycle_status TEXT NOT NULL,
    state_code TEXT,
    start_date INTEGER,
    end_date INTEGER
  );
`;

/** Unix SECONDS — the storage unit for D1 date columns in raw SQL. A `*1000`
 *  here returns zero rows and no error, which reads as a finding rather than a
 *  bug (see feedback_d1_date_columns_are_seconds_in_raw_sql). */
const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/** Exactly what the function under test accepts, so the one better-sqlite3 ->
 *  D1 cast lives at the harness boundary rather than at every call site. */
type TestDb = Parameters<typeof getUpcomingEventYearSpanByState>[0];

let raw: Database.Database;
let db: TestDb;
let seq = 0;

function seed(opts: {
  start: string;
  end: string;
  state?: string | null;
  status?: string;
  lifecycle?: string;
}) {
  raw
    .prepare(
      `INSERT INTO events (id, status, lifecycle_status, state_code, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `e${++seq}`,
      opts.status ?? "APPROVED",
      opts.lifecycle ?? "SCHEDULED",
      opts.state === undefined ? "ME" : opts.state,
      secs(opts.start),
      secs(opts.end)
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as TestDb;
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
  raw.close();
});

describe("formatYearSpanLabel", () => {
  it("renders a single year bare", () => {
    expect(formatYearSpanLabel({ minYear: 2026, maxYear: 2026 })).toBe("2026");
  });

  it("renders a two-year span with an EN DASH, not a hyphen", () => {
    // The typographic character is the assertion: a hyphen here would be a
    // silent copy regression on six high-value pages.
    expect(formatYearSpanLabel({ minYear: 2026, maxYear: 2027 })).toBe("2026–2027");
  });

  it("falls back to the CURRENT year when a state lists nothing — OPE-394's approval condition", () => {
    // If this fallback is ever weakened to "", every state page with an empty
    // calendar silently loses the year from its <title>. That is a SERP-visible
    // copy change, and `buildStateTitle`'s docblock assigns that decision to
    // John. OPE-598 is allowed to change the SOURCE of the year, never its
    // presence — so this test is the boundary between the two tickets.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-05-05T12:00:00Z"));
    expect(formatYearSpanLabel(null)).toBe("2029");
  });

  it("keeps the fallback evergreen — not a two-value special case", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2033-02-02T12:00:00Z"));
    expect(formatYearSpanLabel(null)).toBe("2033");
  });
});

describe("getUpcomingEventYearSpanByState", () => {
  it("reports NEXT year in late December when that is all the state lists — the defect", () => {
    // The whole ticket, in one case. Under the old clock-derived year this page
    // was headed 2026 while every event on it was 2027.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-20T12:00:00Z"));
    seed({ start: "2027-03-01T15:00:00Z", end: "2027-03-02T15:00:00Z" });
    return expect(getUpcomingEventYearSpanByState(db, "ME")).resolves.toEqual({
      minYear: 2027,
      maxYear: 2027,
    });
  });

  it("spans two years when the inventory straddles the turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    seed({ start: "2026-11-15T15:00:00Z", end: "2026-11-16T15:00:00Z" });
    seed({ start: "2027-06-01T15:00:00Z", end: "2027-06-02T15:00:00Z" });
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toEqual({
      minYear: 2026,
      maxYear: 2027,
    });
  });

  it("reads the year in EASTERN, not UTC — an event at 02:00Z on 1 Jan is still December here", async () => {
    // 2027-01-01T02:00:00Z is 2026-12-31 21:00 in New York. A plain
    // getUTCFullYear() returns 2027 and mislabels the page by a whole year on
    // exactly the boundary the site's date convention exists to handle.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-30T12:00:00Z"));
    seed({ start: "2027-01-01T02:00:00Z", end: "2027-01-01T06:00:00Z" });
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toEqual({
      minYear: 2026,
      maxYear: 2026,
    });
  });

  it("returns null when the state lists nothing upcoming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toBeNull();
  });

  it("ignores events that have already ended", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    seed({ start: "2025-04-01T15:00:00Z", end: "2025-04-02T15:00:00Z" });
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toBeNull();
  });

  it("ignores other states, so one state's calendar cannot title another's page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    seed({ start: "2027-04-01T15:00:00Z", end: "2027-04-02T15:00:00Z", state: "NH" });
    seed({ start: "2026-09-01T15:00:00Z", end: "2026-09-02T15:00:00Z", state: "ME" });
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toEqual({
      minYear: 2026,
      maxYear: 2026,
    });
  });

  it("ignores non-public rows, so a PENDING 2028 submission cannot move the title", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    seed({ start: "2026-09-01T15:00:00Z", end: "2026-09-02T15:00:00Z" });
    seed({ start: "2028-09-01T15:00:00Z", end: "2028-09-02T15:00:00Z", status: "PENDING" });
    expect(await getUpcomingEventYearSpanByState(db, "ME")).toEqual({
      minYear: 2026,
      maxYear: 2026,
    });
  });
});
