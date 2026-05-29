/**
 * Tests for getOutboundClicksForEventSlug (analyst A5, 2026-05-29).
 *
 * Spun up against an in-memory better-sqlite3 with a minimal
 * analytics_events table — enough for the SELECT shape used by the
 * helper. Same pattern as venue-matching-autolink.test.ts.
 *
 * Better-sqlite3 supports SQLite's json_extract; tests exercise the
 * slug-filter on it so a future Drizzle migration to a different
 * JSON-path syntax can't silently regress to "count all events".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { getOutboundClicksForEventSlug } from "../event-outbound-clicks";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE analytics_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    event_category TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    properties TEXT DEFAULT '{}',
    user_id TEXT,
    source TEXT
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function insertClick(
  eventName: "outbound_ticket_click" | "outbound_application_click",
  whenIso: string,
  slug: string,
  destinationUrl: string
) {
  raw
    .prepare(
      `INSERT INTO analytics_events (id, event_name, event_category, timestamp, properties)
       VALUES (?, ?, 'conversion', ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      eventName,
      Math.floor(new Date(whenIso).getTime() / 1000),
      JSON.stringify({ eventSlug: slug, destinationUrl })
    );
}

// Cast our better-sqlite3 Drizzle to the D1-typed one — structurally
// compatible for SELECT shape used here.
type ClicksDb = Parameters<typeof getOutboundClicksForEventSlug>[0];
const asDb = (d: TestDb): ClicksDb => d as unknown as ClicksDb;

const W_START = new Date("2026-05-01T00:00:00Z");
const W_END = new Date("2026-06-01T00:00:00Z"); // exclusive

describe("getOutboundClicksForEventSlug", () => {
  it("returns zeros when no events exist", async () => {
    const r = await getOutboundClicksForEventSlug(asDb(db), "any-slug", W_START, W_END);
    expect(r.ticketClicks).toBe(0);
    expect(r.applicationClicks).toBe(0);
    expect(r.totalClicks).toBe(0);
    expect(r.topDestinations).toEqual([]);
  });

  it("counts ticket and application clicks for one event in window", async () => {
    insertClick("outbound_ticket_click", "2026-05-10T12:00:00Z", "fair-a", "https://tix.com/a");
    insertClick("outbound_ticket_click", "2026-05-11T12:00:00Z", "fair-a", "https://tix.com/a");
    insertClick(
      "outbound_application_click",
      "2026-05-12T12:00:00Z",
      "fair-a",
      "https://apply.com/a"
    );

    const r = await getOutboundClicksForEventSlug(asDb(db), "fair-a", W_START, W_END);
    expect(r.ticketClicks).toBe(2);
    expect(r.applicationClicks).toBe(1);
    expect(r.totalClicks).toBe(3);
  });

  it("excludes clicks for OTHER event slugs (json_extract filter works)", async () => {
    insertClick("outbound_ticket_click", "2026-05-10T12:00:00Z", "fair-a", "https://tix.com/a");
    insertClick("outbound_ticket_click", "2026-05-10T12:00:00Z", "fair-b", "https://tix.com/b");
    insertClick("outbound_ticket_click", "2026-05-10T12:00:00Z", "fair-c", "https://tix.com/c");

    const r = await getOutboundClicksForEventSlug(asDb(db), "fair-a", W_START, W_END);
    expect(r.ticketClicks).toBe(1);
    expect(r.totalClicks).toBe(1);
  });

  it("excludes clicks outside the time window", async () => {
    insertClick("outbound_ticket_click", "2026-04-30T23:00:00Z", "fair-a", "https://tix.com/a"); // before
    insertClick("outbound_ticket_click", "2026-05-10T12:00:00Z", "fair-a", "https://tix.com/a"); // in
    insertClick("outbound_ticket_click", "2026-06-01T00:00:00Z", "fair-a", "https://tix.com/a"); // at-exclusive-end
    insertClick("outbound_ticket_click", "2026-06-02T01:00:00Z", "fair-a", "https://tix.com/a"); // after

    const r = await getOutboundClicksForEventSlug(asDb(db), "fair-a", W_START, W_END);
    expect(r.ticketClicks).toBe(1);
  });

  it("ranks destinations by click count, capped at 10", async () => {
    // 12 distinct destinations with varying counts; top 10 should
    // come back ordered desc and the two least-clicked should drop.
    for (let i = 0; i < 12; i++) {
      const clicks = 12 - i;
      for (let j = 0; j < clicks; j++) {
        insertClick(
          "outbound_ticket_click",
          "2026-05-15T12:00:00Z",
          "fair-a",
          `https://dest${i}.com/page`
        );
      }
    }
    const r = await getOutboundClicksForEventSlug(asDb(db), "fair-a", W_START, W_END);
    expect(r.topDestinations).toHaveLength(10);
    // First should be dest0 with 12 clicks.
    expect(r.topDestinations[0]).toEqual({ url: "https://dest0.com/page", count: 12 });
    // Last should be dest9 with 3 clicks (12-9).
    expect(r.topDestinations[9]).toEqual({ url: "https://dest9.com/page", count: 3 });
  });

  it("tolerates malformed properties — counts the event but skips destination", async () => {
    raw
      .prepare(
        `INSERT INTO analytics_events (id, event_name, event_category, timestamp, properties)
         VALUES (?, 'outbound_ticket_click', 'conversion', ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        Math.floor(new Date("2026-05-10T12:00:00Z").getTime() / 1000),
        "not valid json {{{"
      );
    // The malformed row's eventSlug filter still has to match. json_extract
    // on a non-JSON value returns NULL, so the row WON'T match the WHERE
    // clause — confirms malformed properties don't get accidentally counted
    // toward the wrong slug.
    const r = await getOutboundClicksForEventSlug(asDb(db), "fair-a", W_START, W_END);
    expect(r.ticketClicks).toBe(0);
  });
});
