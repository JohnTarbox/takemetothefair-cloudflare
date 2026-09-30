/**
 * OPE-1201 — the periodic near-duplicate candidate pass.
 *
 * Pure fixtures are the real 2026-09-28 shapes: a same-venue twin with a date
 * 8 days wrong (Harvest Festival of Crafts ↔ Augusta Armory Fall Harvest), one 6
 * days wrong (Tanger), and OPE-627's own unflagged fixtures (PTTF ↔ Thornton's
 * Ferry, which share no name token; SSMC ↔ Scarborough HS). The recurring-market
 * case is the measured false-positive class the refinement exists for.
 *
 * The DB block runs the sweep over OPE-627's real census and asserts the
 * report-only property: nothing but `possible_duplicate_of` changes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  NEAR_DUPLICATE_SWEEP_ACTION,
  nearDuplicateReason,
  planNearDuplicateFlags,
  runNearDuplicateSweep,
  type SweepEventRow,
} from "../near-duplicate-sweep";
import { CENSUS } from "./fixtures-ope627-census";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
let seq = 0;
function row(p: Partial<SweepEventRow> & { name: string; start: string }): SweepEventRow {
  seq += 1;
  return {
    id: p.id ?? `e${seq}`,
    name: p.name,
    venueId: p.venueId ?? "v-armory",
    venueName: p.venueName ?? "Augusta Armory",
    venueCity: p.venueCity ?? "Augusta",
    seriesId: p.seriesId ?? null,
    promoterId: p.promoterId ?? null,
    startDate: at(p.start),
    createdAt: p.createdAt ?? new Date(seq * 1000),
    possibleDuplicateOf: p.possibleDuplicateOf ?? null,
  };
}

describe("nearDuplicateReason — the 2026-09-28 shapes", () => {
  it("ACCEPTANCE: a same-venue row with a date 8 days off is a candidate", () => {
    const real = row({
      name: "Augusta Armory Fall Harvest Arts and Craft Show 2026",
      start: "2026-10-31",
    });
    const wrong = row({ name: "Harvest Festival of Crafts 2026", start: "2026-10-23" });
    expect(nearDuplicateReason(real, wrong)).toMatchObject({
      reason: "same_venue_name",
      startDeltaDays: 8,
      sharedDistinctive: ["harvest"],
    });
  });

  it("the Tanger pair, 6 days apart, shares 'tanger' once the venue's own tokens are stripped", () => {
    const place = { venueId: "v-tanger", venueName: "Tanger Outlets", venueCity: "Tilton" };
    const a = row({ ...place, name: "Silver Bells Craft Fair at Tanger", start: "2026-10-31" });
    const b = row({
      ...place,
      name: "Holiday Craft Fair Tanger Outlets Tilton 2026",
      start: "2026-10-25",
    });
    // "tanger" is part of the venue name, so it is stripped — this pair is NOT
    // caught by name. Stated rather than hidden: the venue-name strip is what
    // removes the "beans greens farm" class, and it costs this one.
    expect(nearDuplicateReason(a, b)).toBeNull();
  });

  it("PTTF ↔ Thornton's Ferry: same venue, same day, NO shared token — still a candidate", () => {
    const place = {
      venueId: "v-pttf",
      venueName: "Thornton's Ferry School",
      venueCity: "Merrimack",
    };
    const a = row({ ...place, name: "PTTF Holiday Craft Fair 2026", start: "2026-11-21" });
    const b = row({
      ...place,
      name: "Thorntons Ferry Holiday Craft Fair 2026",
      start: "2026-11-21",
    });
    expect(nearDuplicateReason(a, b)?.reason).toBe("same_venue_same_day");
  });

  it("different venues never pair, however alike the names", () => {
    const a = row({ name: "Snowport Holiday Market", start: "2026-11-06", venueId: "v-1" });
    const b = row({ name: "Snowport Holiday Market", start: "2026-11-06", venueId: "v-2" });
    expect(nearDuplicateReason(a, b)).toBeNull();
  });

  it("15 days apart is outside the window", () => {
    const a = row({ name: "Harvest Festival", start: "2026-10-01" });
    const b = row({ name: "Harvest Festival", start: "2026-10-16" });
    expect(nearDuplicateReason(a, b)).toBeNull();
  });

  it("occurrences of one series are not duplicates", () => {
    const a = row({ name: "Harvest Festival", start: "2026-10-01", seriesId: "s1" });
    const b = row({ name: "Harvest Festival", start: "2026-10-08", seriesId: "s1" });
    expect(nearDuplicateReason(a, b)).toBeNull();
  });

  it("place and month words are not identity (the 'vermont' / 'november' false positives)", () => {
    const place = {
      venueId: "v-expo",
      venueName: "Champlain Valley Expo",
      venueCity: "Essex Junction",
    };
    const a = row({ ...place, name: "Vermont Home Show November 2026", start: "2026-11-01" });
    const b = row({ ...place, name: "Vermont Farm Show November 2026", start: "2026-11-07" });
    expect(nearDuplicateReason(a, b)).toBeNull();
  });
});

describe("planNearDuplicateFlags", () => {
  it("flags the NEWER row, pointing at the older", () => {
    const older = row({ name: "Augusta Armory Fall Harvest Show", start: "2026-10-31" });
    const newer = row({ name: "Harvest Festival of Crafts", start: "2026-10-23" });
    expect(planNearDuplicateFlags([older, newer], new Set())).toEqual([
      expect.objectContaining({ eventId: newer.id, candidateId: older.id }),
    ]);
  });

  it("a recurring schedule (≥3 same-signature rows at a venue) is skipped", () => {
    const place = { venueId: "v-river", venueName: "River Garden", venueCity: "Brattleboro" };
    const weekly = ["2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"].map((d) =>
      row({ ...place, name: "Brattleboro Winter Farmers Market", start: d })
    );
    expect(planNearDuplicateFlags(weekly, new Set())).toEqual([]);
  });

  it("…but TWO same-signature rows are a pair, and are flagged", () => {
    const place = { venueId: "v-river", venueName: "River Garden", venueCity: "Brattleboro" };
    const pair = ["2026-11-07", "2026-11-14"].map((d) =>
      row({ ...place, name: "Fiddlehead Craft Fair", start: d })
    );
    expect(planNearDuplicateFlags(pair, new Set())).toHaveLength(1);
  });

  it("a pair a human dismissed is never re-flagged (either order)", () => {
    const a = row({ name: "Harvest Festival of Crafts", start: "2026-10-23" });
    const b = row({ name: "Fall Harvest Craft Show", start: "2026-10-31" });
    expect(
      planNearDuplicateFlags(
        [a, b],
        new Set([`${b.id}|${a.id}`].map((k) => k.split("|").sort().join("|")))
      )
    ).toEqual([]);
  });

  it("never overwrites a row that already carries a flag", () => {
    const a = row({
      name: "Harvest Festival of Crafts",
      start: "2026-10-23",
      possibleDuplicateOf: "other",
    });
    const b = row({ name: "Fall Harvest Craft Show", start: "2026-10-31" });
    const plan = planNearDuplicateFlags([b, a], new Set());
    expect(plan.every((p) => p.eventId !== a.id)).toBe(true);
  });
});

// ── DB-backed: OPE-627's real census, report-only ─────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT, city TEXT);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'APPROVED', venue_id TEXT, promoter_id TEXT,
    series_id TEXT, start_date INTEGER, end_date INTEGER, merged_into TEXT,
    possible_duplicate_of TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE event_duplicate_dismissals (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
    dismissed_by TEXT, dismissed_at INTEGER NOT NULL, note TEXT
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT NOT NULL,
    target_id TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-01-01T00:00:00Z"); // every census date is upcoming
const sec = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  CENSUS.forEach((r, i) => {
    raw
      .prepare(`INSERT OR IGNORE INTO venues (id,name,city) VALUES (?,?,?)`)
      .run(r.venue, `Venue ${r.venue}`, "Town");
    raw
      .prepare(
        `INSERT INTO events (id,name,slug,status,venue_id,promoter_id,start_date,end_date,merged_into,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.slug,
        r.name,
        r.slug,
        r.status ?? "APPROVED",
        r.venue,
        r.promoter,
        sec(r.start),
        sec(r.end),
        r.merged ?? null,
        i
      );
  });
});

const snapshot = () =>
  raw
    .prepare(
      `SELECT id,name,slug,status,venue_id,promoter_id,start_date,end_date,merged_into FROM events ORDER BY id`
    )
    .all();

describe("runNearDuplicateSweep over OPE-627's census — REPORT-ONLY", () => {
  it("changes nothing but possible_duplicate_of: zero merges, zero status changes", async () => {
    const before = snapshot();
    const res = await runNearDuplicateSweep(db as never, { now: NOW, dryRun: false });
    expect(snapshot()).toEqual(before);
    // Landmark: the census is non-trivial and the sweep did write.
    const live = CENSUS.filter(
      (r) => !r.merged && ["APPROVED", "TENTATIVE", "PENDING"].includes(r.status ?? "APPROVED")
    ).length;
    expect(live).toBeGreaterThan(10);
    expect(res.examined).toBe(live);
    expect(res.written).toBeGreaterThan(0);
    expect(res.written).toBe(res.planned.length);
  });

  it("PTTF is flagged — the fixture OPE-627 named and never flagged", async () => {
    await runNearDuplicateSweep(db as never, { now: NOW, dryRun: false });
    const flagged = raw
      .prepare(
        `SELECT id, possible_duplicate_of FROM events WHERE possible_duplicate_of IS NOT NULL`
      )
      .all() as Array<{ id: string; possible_duplicate_of: string }>;
    const ids = new Set(flagged.flatMap((f) => [f.id, f.possible_duplicate_of]));
    expect([...ids].some((id) => id.includes("pttf") || id.includes("thornton"))).toBe(true);
  });

  it("dry run writes no flag, but still records the run (heartbeat evidence)", async () => {
    const res = await runNearDuplicateSweep(db as never, { now: NOW, dryRun: true });
    expect(res.planned.length).toBeGreaterThan(0);
    expect(res.written).toBe(0);
    const flagged = raw
      .prepare(`SELECT COUNT(*) n FROM events WHERE possible_duplicate_of IS NOT NULL`)
      .get() as { n: number };
    expect(flagged.n).toBe(0);
    const runs = raw.prepare(`SELECT action, payload_json FROM admin_actions`).all() as Array<{
      action: string;
      payload_json: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].action).toBe(NEAR_DUPLICATE_SWEEP_ACTION);
    expect(JSON.parse(runs[0].payload_json)).toMatchObject({ dryRun: true, written: 0 });
  });

  it("is idempotent: a second run plans nothing new", async () => {
    await runNearDuplicateSweep(db as never, { now: NOW, dryRun: false });
    const second = await runNearDuplicateSweep(db as never, { now: NOW, dryRun: false });
    expect(second.written).toBe(0);
  });
});
