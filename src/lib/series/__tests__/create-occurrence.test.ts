/**
 * K34 / EH3 P3.1 — createOccurrenceForSeries guard paths (series_not_found,
 * year-bucketed idempotency). The happy-path insert is a byte-identical
 * extraction of the prior `/api/admin/occurrences/create` route body; the pure
 * field inheritance is covered by create-occurrence-core.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { createOccurrenceForSeries } from "../create-occurrence";

const SCHEMA_SQL = `
  CREATE TABLE event_series (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    venue_id TEXT,
    promoter_id TEXT,
    recurrence_rule TEXT,
    description TEXT,
    image_url TEXT,
    categories TEXT,
    tags TEXT,
    primary_audience TEXT NOT NULL DEFAULT 'PUBLIC',
    public_access TEXT NOT NULL DEFAULT 'OPEN'
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    series_id TEXT,
    slug TEXT NOT NULL,
    start_date INTEGER,
    end_date INTEGER,
    discontinuous_dates INTEGER DEFAULT 0,
    updated_at INTEGER
  );
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    date TEXT NOT NULL,
    open_time TEXT,
    close_time TEXT,
    notes TEXT,
    closed INTEGER DEFAULT 0,
    vendor_only INTEGER DEFAULT 0,
    image_url TEXT,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

function seedSeries(id: string, promoterId: string | null, recurrenceRule: string | null = null) {
  raw
    .prepare(
      `INSERT INTO event_series (id, name, promoter_id, recurrence_rule, primary_audience, public_access) VALUES (?, ?, ?, ?, 'PUBLIC', 'OPEN')`
    )
    .run(id, "Cheshire Fair", promoterId, recurrenceRule);
}
function seedSibling(
  id: string,
  seriesId: string,
  slug: string,
  startIso: string | null,
  endIso: string | null = null
) {
  const sec = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);
  raw
    .prepare(
      `INSERT INTO events (id, series_id, slug, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, seriesId, slug, sec(startIso), sec(endIso));
}
function dayCount(eventId: string): number {
  return (
    raw.prepare(`SELECT COUNT(*) AS n FROM event_days WHERE event_id = ?`).get(eventId) as {
      n: number;
    }
  ).n;
}

describe("createOccurrenceForSeries — guards", () => {
  it("returns series_not_found for an unknown series", async () => {
    const res = await createOccurrenceForSeries(db as never, { seriesId: "nope", year: 2027 });
    expect(res).toEqual({ created: false, reason: "series_not_found", year: 2027 });
  });

  it("is idempotent by year: returns occurrence_exists when a sibling already has that year (via start_date)", async () => {
    seedSeries("s1", "promoter1");
    seedSibling("e2026", "s1", "cheshire-fair-2026", "2026-08-01T00:00:00Z");
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2026 });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2026",
      year: 2026,
    });
  });

  it("detects an existing year from a -YYYY slug suffix when start_date is null", async () => {
    seedSeries("s1", "promoter1");
    seedSibling("e2027", "s1", "cheshire-fair-2027", null);
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2027",
      year: 2027,
    });
  });

  it("returns promoter_required when the series has no default promoter and none is supplied", async () => {
    seedSeries("s1", null);
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(res).toEqual({ created: false, reason: "promoter_required", year: 2027 });
  });
});

// OPE-28 — for a sub-annual (FREQ=MONTHLY) series, a same-year hit is a NEW DATE
// of the existing year-occurrence: attach it as an event_day instead of dropping
// it (the bug that minted month-suffixed siblings).
describe("createOccurrenceForSeries — sub-annual (monthly) same-year attach", () => {
  it("attaches a new same-year date as an event_day on the existing occurrence", async () => {
    seedSeries("s1", "promoter1", "FREQ=MONTHLY");
    // Existing 2026 occurrence with its July date.
    seedSibling(
      "e2026",
      "s1",
      "nashua-coin-show-2026",
      "2026-07-19T00:00:00Z",
      "2026-07-19T00:00:00Z"
    );
    expect(dayCount("e2026")).toBe(0);

    const res = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2026,
      overrides: { startDate: new Date("2026-09-20T00:00:00Z"), endDate: null },
    });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2026",
      year: 2026,
      attachedEventDay: true,
    });
    // A day row for the new date exists; the occurrence is now discontinuous and
    // its end_date widened to the later date.
    const day = raw.prepare(`SELECT date FROM event_days WHERE event_id = 'e2026'`).get() as {
      date: string;
    };
    expect(day.date).toBe("2026-09-20");
    const ev = raw
      .prepare(`SELECT discontinuous_dates AS d, end_date AS e FROM events WHERE id = 'e2026'`)
      .get() as { d: number; e: number };
    expect(ev.d).toBe(1);
    expect(ev.e).toBe(Math.floor(new Date("2026-09-20T00:00:00Z").getTime() / 1000));
  });

  it("is idempotent: re-attaching the same date does not duplicate the event_day", async () => {
    seedSeries("s1", "promoter1", "FREQ=MONTHLY");
    seedSibling("e2026", "s1", "nashua-coin-show-2026", "2026-07-19T00:00:00Z");
    const overrides = { startDate: new Date("2026-09-20T00:00:00Z"), endDate: null };

    const first = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2026,
      overrides,
    });
    expect(first).toMatchObject({ attachedEventDay: true });
    const second = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2026,
      overrides,
    });
    expect(second).toMatchObject({ attachedEventDay: false });
    expect(dayCount("e2026")).toBe(1);
  });

  it("does NOT attach for an annual series — a same-year hit stays a true no-op duplicate", async () => {
    seedSeries("s1", "promoter1", "FREQ=YEARLY");
    seedSibling("e2026", "s1", "cheshire-fair-2026", "2026-08-01T00:00:00Z");
    const res = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2026,
      overrides: { startDate: new Date("2026-09-01T00:00:00Z"), endDate: null },
    });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2026",
      year: 2026,
    });
    expect(dayCount("e2026")).toBe(0);
  });
});
