/**
 * OPE-1573 — the venues event count is "same numbers, one scan".
 *
 * The core assertion runs the PRE-OPE-1573 correlated subquery (copied verbatim
 * from src/app/venues/(listing)/page.tsx at 0b588320) and the new grouped join
 * against one seeded database and requires identical per-venue counts,
 * including the edge rows the filter exists for: non-public status, cancelled
 * / no-show lifecycle, past events, NULL end date, and a venue with none.
 *
 * The cost half asserts the statement SHAPE: the new query has no correlated
 * subquery referencing `venues.id` (the thing that made prod read ~708K rows
 * per render), and the analytics index makes MAX(timestamp) a search, not a
 * scan. Local sqlite's planner is not D1's, so the prod row counts live in the
 * ticket, measured on prod; this guards the shape that produced them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { and, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../db/schema";
import { events, venues } from "../../db/schema";
import { upcomingEndPredicate } from "../../event-dates";
import {
  joinVenueCounts,
  upcomingEventCountsByVenue,
  venueEventCount,
} from "../upcoming-event-counts";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const NOW = new Date("2026-11-04T03:00:00Z");
const DAY = 86_400;
const nowSec = Math.floor(NOW.getTime() / 1000);

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let prepared: string[];

function venue(id: string, name: string) {
  raw
    .prepare(`INSERT INTO venues (id, name, slug, status) VALUES (?, ?, ?, 'ACTIVE')`)
    .run(id, name, id);
}
let n = 0;
function event(
  venueId: string | null,
  o: { status?: string; lifecycle?: string; startOffset?: number; endOffset?: number | null } = {}
) {
  n++;
  const start = nowSec + (o.startOffset ?? 10) * DAY;
  const end =
    o.endOffset === null ? null : nowSec + (o.endOffset ?? (o.startOffset ?? 10) + 1) * DAY;
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, venue_id, status, lifecycle_status, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `e${n}`,
      `Event ${n}`,
      `event-${n}`,
      venueId,
      o.status ?? "APPROVED",
      o.lifecycle ?? "SCHEDULED",
      start,
      end
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(venues));
  raw.exec(ddlFor(events));
  raw.exec(ddlFor(schema.analyticsEvents));
  prepared = [];
  const origPrepare = raw.prepare.bind(raw);
  raw.prepare = ((s: string) => {
    prepared.push(s);
    return origPrepare(s);
  }) as typeof raw.prepare;
  db = drizzle(raw, { schema });
  n = 0;

  venue("v-a", "Alpha Fairgrounds");
  venue("v-b", "Bravo Hall");
  venue("v-c", "Charlie Common"); // no events at all
  venue("v-d", "Delta Park"); // only events the filter must exclude

  event("v-a"); // counts
  event("v-a", { status: "TENTATIVE" }); // counts
  event("v-a", { startOffset: 0, endOffset: 0 }); // in progress today: counts
  event("v-a", { startOffset: 5, endOffset: null }); // NULL end, future start: counts
  event("v-b"); // counts
  event("v-b", { lifecycle: "POSTPONED" }); // counts (not cancelled/no-show)
  event("v-d", { status: "PENDING" });
  event("v-d", { status: "REJECTED" });
  event("v-d", { lifecycle: "CANCELLED" });
  event("v-d", { lifecycle: "NO_SHOW" });
  event("v-d", { startOffset: -30, endOffset: -29 }); // past
  event("v-d", { startOffset: -30, endOffset: null }); // past, NULL end
  event(null); // no venue: must not appear as a phantom venue
});

/** The pre-OPE-1573 query, verbatim apart from the select list being trimmed. */
async function legacyCounts() {
  const eventCountSubquery = sql<number>`(
      SELECT COUNT(*) FROM events
      WHERE events.venue_id = venues.id
      AND events.status IN ('APPROVED', 'TENTATIVE')
      AND events.lifecycle_status NOT IN ('CANCELLED', 'NO_SHOW')
      AND ${upcomingEndPredicate(NOW)}
    )`;
  return db
    .select({ id: venues.id, eventCount: eventCountSubquery.as("event_count") })
    .from(venues)
    .orderBy(venues.name);
}

async function newCounts(hasEvents = false) {
  const counts = upcomingEventCountsByVenue(db as never, NOW);
  const eventCount = venueEventCount(counts);
  return db
    .select({ id: venues.id, eventCount: eventCount.as("event_count") })
    .from(venues)
    .leftJoin(counts, joinVenueCounts(counts))
    .where(hasEvents ? and(sql`${eventCount} > 0`) : undefined)
    .orderBy(venues.name);
}

describe("upcomingEventCountsByVenue", () => {
  it("returns exactly the legacy per-venue counts, every venue, same order", async () => {
    const before = await legacyCounts();
    const after = await newCounts();
    expect(after).toEqual(before);
    // Positive landmark: the fixture actually exercises non-zero AND zero rows.
    expect(after).toEqual([
      { id: "v-a", eventCount: 4 },
      { id: "v-b", eventCount: 2 },
      { id: "v-c", eventCount: 0 },
      { id: "v-d", eventCount: 0 },
    ]);
  });

  it("hasEvents=true keeps only venues with upcoming events", async () => {
    expect((await newCounts(true)).map((r) => r.id)).toEqual(["v-a", "v-b"]);
  });

  it("no correlated subquery on venues.id — one grouped scan joined in", async () => {
    prepared = [];
    await newCounts(true);
    const stmt = prepared.find((s) => s.includes('from "venues"'));
    expect(stmt, "the venues select was not captured").toBeTruthy();
    expect(stmt).toMatch(/group by "events"\."venue_id"/i);
    expect(stmt).not.toMatch(/"events"\."venue_id"\s*=\s*"venues"\."id"/i);
    expect(stmt).not.toMatch(/events\.venue_id\s*=\s*venues\.id/i);
  });
});

describe("drizzle/0393 analytics_events(timestamp) index", () => {
  it("turns MAX(timestamp) and the range COUNT into index reads", () => {
    const sqlText = readFileSync(
      join(__dirname, "../../../../drizzle/0393_ope1573_analytics_events_timestamp_index.sql"),
      "utf8"
    );
    const plan = (q: string) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
    const maxQ = "SELECT MAX(timestamp) FROM analytics_events";
    const rangeQ = "SELECT COUNT(*) FROM analytics_events WHERE timestamp >= 100";
    // Before: a scan (driven to failure — the assertion below is not vacuous).
    expect(plan(rangeQ)).toMatch(/SCAN/);
    raw.exec(sqlText);
    raw.exec(sqlText); // idempotent
    expect(plan(maxQ)).toMatch(/idx_analytics_events_timestamp/);
    expect(plan(rangeQ)).toMatch(/SEARCH .*idx_analytics_events_timestamp/);
  });
});
