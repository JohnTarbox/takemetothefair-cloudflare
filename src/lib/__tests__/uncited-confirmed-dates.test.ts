/**
 * OPE-384 stage 5 — an unsupported date claim, escalated instead of counted.
 *
 * The specimen is Dartmouth Grange Fair 2026: `dates_confirmed = 1` for
 * Sep 11-12 while the organizer's own site still showed the 2024 dates. Nothing
 * was mechanically broken — the flag can simply be set with nothing behind it,
 * and once set it is indistinguishable from a date somebody actually verified.
 *
 * The SQL is the substance here, so most of this exercises the real predicate
 * against a real database rather than the pure assessor. The cases that matter
 * are the near-misses: a citation on the wrong field, a citation that has been
 * superseded, and an event that is not public.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  loadUncitedConfirmedDates,
  loadUncitedMin,
  assessUncitedConfirmedDates,
  DEFAULT_UNCITED_MIN,
  UNCITED_CONFIRMED_DATES_KEY,
} from "../uncited-confirmed-dates";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT, slug TEXT, promoter_id TEXT,
    status TEXT NOT NULL DEFAULT 'APPROVED', merged_into TEXT,
    start_date INTEGER, end_date INTEGER,
    dates_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE event_data_citations (
    id TEXT PRIMARY KEY, event_id TEXT, field_name TEXT, state TEXT,
    source_url TEXT, created_at INTEGER
  );
  CREATE TABLE tunable_thresholds (
    key TEXT PRIMARY KEY, value REAL, updated_at INTEGER
  );
`;

const NOW = new Date("2026-08-31T12:00:00Z");
const secs = (d: string) => Math.floor(new Date(d).getTime() / 1000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: Database.Database;

const event = (
  id: string,
  over: Partial<{
    status: string;
    mergedInto: string | null;
    startDate: string;
    datesConfirmed: number;
    createdAt: string;
  }> = {}
) =>
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, status, merged_into, start_date, dates_confirmed, created_at)
       VALUES (?, ?, ?, 'pr1', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `Fair ${id}`,
      `fair-${id}`,
      over.status ?? "APPROVED",
      over.mergedInto ?? null,
      secs(over.startDate ?? "2026-10-01T00:00:00Z"),
      over.datesConfirmed ?? 1,
      secs(over.createdAt ?? "2026-08-01T00:00:00Z")
    );

const citation = (eventId: string, fieldName: string, state = "active") =>
  raw
    .prepare(
      `INSERT INTO event_data_citations (id, event_id, field_name, state, source_url, created_at)
       VALUES (?, ?, ?, ?, 'https://x.test', 0)`
    )
    .run(`${eventId}-${fieldName}-${state}`, eventId, fieldName, state);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("loadUncitedConfirmedDates — the predicate", () => {
  it("counts a confirmed upcoming event with no citation at all", async () => {
    event("dartmouth");
    const s = await loadUncitedConfirmedDates(db, NOW);
    expect(s.count).toBe(1);
  });

  it("does NOT count one backed by an active start_date citation", async () => {
    event("e1");
    citation("e1", "start_date");
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(0);
  });

  it("accepts an end_date citation as backing too", async () => {
    event("e1");
    citation("e1", "end_date");
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(0);
  });

  it("COUNTS one whose only date citation has been superseded", async () => {
    // The near-miss that matters. A superseded citation is the record of a
    // claim we have since withdrawn; treating its existence as backing would
    // mean a date could be permanently vouched for by evidence we replaced.
    event("e1");
    citation("e1", "start_date", "superseded");
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(1);
  });

  it("COUNTS one cited only on an unrelated field", async () => {
    // An attendance figure with a source does not vouch for the dates.
    event("e1");
    citation("e1", "estimated_attendance");
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(1);
  });

  it("ignores events whose dates are not claimed as confirmed", async () => {
    event("e1", { datesConfirmed: 0 });
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(0);
  });

  it("ignores past events, tombstones and non-public rows", async () => {
    event("past", { startDate: "2026-01-01T00:00:00Z" });
    event("tomb", { mergedInto: "keeper" });
    event("pending", { status: "PENDING" });
    expect((await loadUncitedConfirmedDates(db, NOW)).count).toBe(0);
  });

  it("ages from the OLDEST offender, so a months-old backlog escalates now", async () => {
    // Anchoring on the newest would restart the 72-hour countdown every time a
    // fresh bad row arrived, and a permanent backlog would look permanently new.
    event("new", { createdAt: "2026-08-30T00:00:00Z" });
    event("old", { createdAt: "2026-05-01T00:00:00Z" });
    const s = await loadUncitedConfirmedDates(db, NOW);
    expect(s.count).toBe(2);
    expect(s.oldestAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("reports no clock when there is nothing wrong", async () => {
    event("e1");
    citation("e1", "start_date");
    expect(await loadUncitedConfirmedDates(db, NOW)).toEqual({ count: 0, oldestAt: null });
  });
});

describe("loadUncitedMin — fails open", () => {
  it("uses the default when no row exists", async () => {
    expect(await loadUncitedMin(db)).toBe(DEFAULT_UNCITED_MIN);
  });

  it("honours an operator-set floor", async () => {
    raw
      .prepare("INSERT INTO tunable_thresholds (key, value, updated_at) VALUES (?, ?, 0)")
      .run(UNCITED_CONFIRMED_DATES_KEY, 100);
    expect(await loadUncitedMin(db)).toBe(100);
  });

  it("falls back to the default on a malformed value — config must not silence", async () => {
    raw
      .prepare("INSERT INTO tunable_thresholds (key, value, updated_at) VALUES (?, ?, 0)")
      .run(UNCITED_CONFIRMED_DATES_KEY, -5);
    expect(await loadUncitedMin(db)).toBe(DEFAULT_UNCITED_MIN);
  });
});

describe("assessUncitedConfirmedDates", () => {
  it("is silent when nothing is uncited", () => {
    expect(assessUncitedConfirmedDates({ count: 0, oldestAt: null }, NOW)).toBeNull();
  });

  it("fires at one, because the default floor is zero", () => {
    const red = assessUncitedConfirmedDates(
      { count: 1, oldestAt: new Date("2026-08-01T12:00:00Z") },
      NOW
    );
    expect(red).not.toBeNull();
    expect(red!.title).toContain("1 upcoming event ");
  });

  it("respects an operator floor that the count has not cleared", () => {
    expect(
      assessUncitedConfirmedDates({ count: 50, oldestAt: new Date(NOW) }, NOW, 100)
    ).toBeNull();
  });

  it("treats the floor as inclusive — a floor of 100 means 100 is still acceptable", () => {
    // The boundary is the whole meaning of the setting. `<` instead of `<=`
    // makes "raise the floor to 100" fire at exactly 100, which is the count
    // the operator just declared tolerable. Away from the boundary the two
    // spellings are indistinguishable, so only this case can tell them apart.
    expect(
      assessUncitedConfirmedDates({ count: 100, oldestAt: new Date(NOW) }, NOW, 100)
    ).toBeNull();
    expect(
      assessUncitedConfirmedDates({ count: 101, oldestAt: new Date(NOW) }, NOW, 100)
    ).not.toBeNull();
  });

  it("keeps the COUNT out of refKey, so it files one ticket and re-mails on change only", () => {
    // staleRedFingerprint keys on refKey. A count in there would make every
    // wobble of one event look like a new red and re-mail the digest, and the
    // CPI auto-file rail would propose a fresh ticket each time.
    const a = assessUncitedConfirmedDates({ count: 448, oldestAt: new Date(NOW) }, NOW)!;
    const b = assessUncitedConfirmedDates({ count: 449, oldestAt: new Date(NOW) }, NOW)!;
    expect(a.refKey).toBe(b.refKey);
    expect(a.refKey).not.toMatch(/\d{3}/);
    expect(a.title).not.toBe(b.title);
  });

  it("is P1, not P0 — bad data, not an outage", () => {
    const red = assessUncitedConfirmedDates({ count: 448, oldestAt: new Date(NOW) }, NOW)!;
    expect(red.priority).toBe("P1");
  });

  it("ages in hours from the oldest offender", () => {
    const red = assessUncitedConfirmedDates(
      { count: 2, oldestAt: new Date("2026-08-30T12:00:00Z") },
      NOW
    )!;
    expect(red.hoursInRed).toBeCloseTo(24, 5);
  });
});
