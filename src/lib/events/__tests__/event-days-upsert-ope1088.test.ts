/**
 * OPE-1088 — one row per (event, date, vendor_only), proved against real
 * SQLite with the real migration rather than a mock.
 *
 * `event_days` accepted unlimited rows for the same (event_id, date) and the
 * ingest/enrichment writer INSERTed, so a later better-sourced correction sat
 * BESIDE the stale value and both rendered — the Hartford CT Fall Home Show
 * (4,306 views) carried 10:00–18:00 and 11:00–17:00 for six months, and the
 * April row was the right one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { insertEventDaysBatched } from "../insert-helpers";

let sqlite: Database.Database;
const db = () => drizzle(sqlite, { schema }) as never;
const EVENT = "615b8649-505d-499c-8863-75036ca9444d";

/** The migration's own text, so the test cannot drift from what ships. */
const MIGRATION = readFileSync(
  join(__dirname, "../../../../drizzle/0299_ope1088_event_days_unique.sql"),
  "utf8"
);

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, flagged_for_review INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
    CREATE TABLE event_days (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL,
      open_time TEXT, close_time TEXT, close_time_unpublished INTEGER NOT NULL DEFAULT 0,
      notes TEXT, internal_notes TEXT, image_url TEXT, image_focal_x REAL,
      image_focal_y REAL, closed INTEGER DEFAULT 0, vendor_only INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE admin_actions (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO events (id) VALUES ('${EVENT}');
  `);
  sqlite.exec(MIGRATION);
});

const days = () =>
  sqlite
    .prepare(
      "SELECT date, open_time, close_time, notes, vendor_only FROM event_days ORDER BY vendor_only, date"
    )
    .all() as Array<Record<string, unknown>>;

describe("OPE-1088 — the double write", () => {
  it("ACCEPTANCE: writing the same (event, date, vendor_only) twice updates one row", async () => {
    // The Hartford shape: March's wrong hours, then April's correction.
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-10-31", openTime: "10:00", closeTime: "18:00" },
    ]);
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-10-31", openTime: "11:00", closeTime: "17:00" },
    ]);
    expect(days()).toEqual([
      {
        date: "2026-10-31",
        open_time: "11:00",
        close_time: "17:00",
        notes: null,
        vendor_only: 0,
      },
    ]);
  });

  it("ACCEPTANCE: a public row and a vendor-setup row on the SAME date both persist", async () => {
    // The GAHS 2026-05-16 fixture named in the ticket.
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-05-16", openTime: "09:00", closeTime: "15:00" },
      {
        date: "2026-05-16",
        openTime: "07:00",
        closeTime: "09:00",
        vendorOnly: true,
        notes: "Vendor setup window.",
      },
    ]);
    expect(days()).toHaveLength(2);
    expect(days().map((d) => d.vendor_only)).toEqual([0, 1]);
  });

  it("ACCEPTANCE: an upsert carrying no note does NOT blank an existing note", async () => {
    // NHAC's two rows differed by nothing but the note.
    await insertEventDaysBatched(db(), EVENT, [
      {
        date: "2026-05-23",
        openTime: "09:00",
        closeTime: "17:00",
        notes: "Public show day — admission $15",
      },
    ]);
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-05-23", openTime: "09:00", closeTime: "17:00" },
    ]);
    const [row] = days();
    expect(row.notes).toBe("Public show day — admission $15");
    // Landmark: a note the writer DOES carry still replaces the stored one.
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-05-23", openTime: "09:00", closeTime: "17:00", notes: "Corrected: $12" },
    ]);
    expect(days()[0].notes).toBe("Corrected: $12");
  });

  it("an upsert that knows no hours does not blank the hours it already has", async () => {
    await insertEventDaysBatched(db(), EVENT, [
      { date: "2026-06-07", openTime: "11:00", closeTime: "18:00" },
    ]);
    await insertEventDaysBatched(db(), EVENT, [{ date: "2026-06-07" }]);
    expect(days()[0]).toMatchObject({ open_time: "11:00", close_time: "18:00" });
  });

  it("the index is what enforces it: a raw second INSERT is rejected", () => {
    sqlite
      .prepare(
        "INSERT INTO event_days (id, event_id, date, vendor_only) VALUES ('a', ?, '2026-07-04', 0)"
      )
      .run(EVENT);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO event_days (id, event_id, date, vendor_only) VALUES ('b', ?, '2026-07-04', 0)"
        )
        .run(EVENT)
    ).toThrow(/UNIQUE constraint failed/);
  });
});
