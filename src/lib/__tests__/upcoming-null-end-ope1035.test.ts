/**
 * OPE-1035 — an event with no end_date is upcoming (and on the weekend facet)
 * while its START is upcoming, exactly as `search_events` and the detail page
 * already treat it. The specimen is `brunswick-american-legion-craft-fair`:
 * APPROVED, 2026-09-19 noon UTC, end_date NULL — absent from every list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and } from "drizzle-orm";
import * as schema from "../db/schema";
import { events } from "../db/schema";
import { upcomingEndPredicate, upcomingEndPredicateRaw } from "../event-dates";
import { facetConditions, resolveFacet } from "../events/facets";

const NOW = new Date("2026-09-15T21:00:00Z"); // Tuesday
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, start_date INTEGER, end_date INTEGER);
    CREATE TABLE event_days (id TEXT PRIMARY KEY, event_id TEXT, date TEXT, closed INTEGER);
    CREATE TABLE venues (id TEXT PRIMARY KEY, city TEXT, state TEXT);
  `);
  const ins = raw.prepare("INSERT INTO events (id, start_date, end_date) VALUES (?, ?, ?)");
  ins.run("brunswick_null_end", sec("2026-09-19T12:00:00Z"), null); // the specimen
  ins.run("normal_upcoming", sec("2026-09-19T12:00:00Z"), sec("2026-09-20T12:00:00Z"));
  ins.run("past_null_end", sec("2026-09-01T12:00:00Z"), null);
  ins.run("past_with_end", sec("2026-09-01T12:00:00Z"), sec("2026-09-02T12:00:00Z"));
  ins.run("no_dates", null, null);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

async function ids(where: ReturnType<typeof upcomingEndPredicate>) {
  const rows = await db.select({ id: events.id }).from(events).where(where);
  return rows.map((r) => r.id).sort();
}

describe("upcomingEndPredicate — NULL end_date means a single-day event", () => {
  it("lists the NULL-end upcoming specimen alongside a normal upcoming event", async () => {
    expect(await ids(upcomingEndPredicate(NOW))).toEqual(["brunswick_null_end", "normal_upcoming"]);
  });

  it("the raw variant agrees", async () => {
    expect(await ids(upcomingEndPredicateRaw(NOW))).toEqual([
      "brunswick_null_end",
      "normal_upcoming",
    ]);
  });

  it("still drops a NULL-end event whose start has passed, and a row with no dates", async () => {
    const got = await ids(upcomingEndPredicate(NOW));
    expect(got).not.toContain("past_null_end");
    expect(got).not.toContain("no_dates");
    expect(got).not.toContain("past_with_end");
  });
});

describe("the this-weekend facet overlap", () => {
  it("includes the NULL-end specimen on Fri-Sun of its weekend", async () => {
    const facet = resolveFacet("maine", "this-weekend", NOW)!;
    const conds = facetConditions("maine", facet, NOW);
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(and(...conds));
    expect(rows.map((r) => r.id).sort()).toEqual(["brunswick_null_end", "normal_upcoming"]);
  });
});
