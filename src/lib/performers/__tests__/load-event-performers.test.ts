/**
 * OPE-114 — loadEventPerformers returns only CONFIRMED, non-deleted acts with
 * the joined day date + epoch-seconds times.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { loadEventPerformers } from "../load-event-performers";

const SCHEMA_SQL = `
  CREATE TABLE performers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, performer_type TEXT,
    act_category TEXT, website TEXT, image_url TEXT, deleted_at INTEGER
  );
  CREATE TABLE event_performers (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, performer_id TEXT NOT NULL,
    event_day_id TEXT, performance_start INTEGER, performance_end INTEGER, stage TEXT,
    billing TEXT, status TEXT NOT NULL DEFAULT 'PENDING'
  );
  CREATE TABLE event_days ( id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
  raw
    .prepare(
      "INSERT INTO performers (id, name, slug, performer_type, website) VALUES ('p1','Mr Drew','mr-drew','PERSON','https://drew.example')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO performers (id, name, slug, deleted_at) VALUES ('p2','Gone Act','gone', 123)"
    )
    .run();
  raw.prepare("INSERT INTO event_days (id, event_id, date) VALUES ('d1','e1','2026-08-15')").run();
  // CONFIRMED, dated, timed.
  raw
    .prepare(
      "INSERT INTO event_performers (id, event_id, performer_id, event_day_id, performance_start, billing, status) VALUES ('a1','e1','p1','d1', 1781000000, 'HEADLINER', 'CONFIRMED')"
    )
    .run();
  // PENDING — excluded.
  raw
    .prepare(
      "INSERT INTO event_performers (id, event_id, performer_id, status) VALUES ('a2','e1','p1','PENDING')"
    )
    .run();
  // CONFIRMED but performer soft-deleted — excluded.
  raw
    .prepare(
      "INSERT INTO event_performers (id, event_id, performer_id, status) VALUES ('a3','e1','p2','CONFIRMED')"
    )
    .run();
});

describe("loadEventPerformers (OPE-114)", () => {
  it("returns only CONFIRMED, non-deleted acts with day date + seconds times", async () => {
    const rows = await loadEventPerformers(db, "e1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      performerName: "Mr Drew",
      performerSlug: "mr-drew",
      performerType: "PERSON",
      sameAs: "https://drew.example",
      billing: "HEADLINER",
      performanceStart: 1781000000,
      dayDate: "2026-08-15",
    });
  });

  it("returns [] for an event with no confirmed acts", async () => {
    expect(await loadEventPerformers(db, "nope")).toEqual([]);
  });
});
