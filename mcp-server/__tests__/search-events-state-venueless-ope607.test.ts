/**
 * OPE-607 — a state-filtered `search_events` must not lose venue-less events.
 *
 * `search_events` LEFT-joins `venues`, so an event with `venue_id IS NULL` IS
 * in the corpus. But the state filter compared `upper(venues.state)`, which is
 * NULL for such a row — and `upper(NULL) = 'ME'` is NULL, not false. So the row
 * failed every state-filtered query while returning normally with `state`
 * omitted, and the tool reported "no match" against a corpus with a hole in it.
 *
 * The live specimen: `Eastern Maine Sportsmen's Show 2027` (`45f7c205`,
 * `state_code='ME'`, `venue_id=NULL`, `status=PENDING`) was absent with
 * `state="ME"` and returned at match_score 1.0 with `state` omitted. Its 2026
 * sibling, venue resolved, returned under both.
 *
 * This is the 4th distinct dedup gap in the same subsystem (OPE-477, OPE-582,
 * OPE-490 are the others), which is itself the argument OPE-477 made for a
 * spec-first rewrite at the 09-05 retro rather than a fifth patch.
 *
 * Run against a real SQLite database, deliberately: asserting that the tool
 * ACCEPTS a `state` parameter would not catch a predicate that takes the
 * argument and then quietly keeps excluding venue-less rows. Same reasoning as
 * the OPE-582 test beside it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { events, venues } from "../src/schema.js";
import { searchEventStateWhere } from "../src/helpers.js";

const SCHEMA_SQL = `
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    city TEXT,
    state TEXT
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING',
    lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    venue_id TEXT,
    state_code TEXT,
    is_statewide INTEGER NOT NULL DEFAULT 0
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(
      `INSERT INTO venues (id,name,slug,city,state) VALUES ('v-me','Bangor Hall','bangor-hall','Bangor','ME')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO venues (id,name,slug,city,state) VALUES ('v-nh','Concord Hall','concord-hall','Concord','NH')`
    )
    .run();
});

function seedEvent(id: string, venueId: string | null, stateCode: string | null) {
  raw
    .prepare(`INSERT INTO events (id, name, slug, venue_id, state_code) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `Event ${id}`, `event-${id}`, venueId, stateCode);
}

/** Run the predicate exactly as search_events does — LEFT join included. */
async function idsForState(state: string): Promise<string[]> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(searchEventStateWhere(state));
  return rows.map((r) => r.id).sort();
}

describe("OPE-607 — state filter reaches venue-less events", () => {
  it("returns the venue-less ME event that used to vanish", async () => {
    // The specimen's shape: no venue, state_code set.
    seedEvent("venueless-me", null, "ME");
    expect(await idsForState("ME")).toContain("venueless-me");
  });

  it("still returns the venue-resolved ME event", async () => {
    // The 2026 sibling. If the widened predicate broke this, the fix would have
    // traded one hole for another.
    seedEvent("venued-me", "v-me", "ME");
    expect(await idsForState("ME")).toContain("venued-me");
  });

  it("does not leak other states", async () => {
    // The whole risk of widening a filter. A venue-less NH row must not appear
    // under ME, or dedup starts matching across state lines.
    seedEvent("venueless-nh", null, "NH");
    seedEvent("venued-nh", "v-nh", "NH");
    seedEvent("venueless-me", null, "ME");
    expect(await idsForState("ME")).toEqual(["venueless-me"]);
  });

  it("does not match a venue-less event with no state_code at all", async () => {
    // NULL state_code must stay unmatched rather than matching everything —
    // `upper(NULL) = upper('ME')` is NULL, and that is the correct outcome here.
    seedEvent("venueless-null", null, null);
    expect(await idsForState("ME")).toEqual([]);
  });

  it("prefers the VENUE's state when a row has both and they disagree", async () => {
    // A resolved venue is authoritative, so a stale `state_code` must not drag
    // the row into the wrong state's results.
    seedEvent("conflict", "v-nh", "ME");
    expect(await idsForState("ME")).toEqual([]);
    expect(await idsForState("NH")).toEqual(["conflict"]);
  });

  it("does NOT fall back to state_code when the venue exists but has no state", async () => {
    // The single case that distinguishes this predicate from
    // `COALESCE(venues.state, events.state_code)` — a mutation to COALESCE
    // passes every other test in this file, so without this one the choice
    // between the two forms is untested and the docblock's claim is unbacked.
    //
    // Not matching is deliberate. A venue with no state is a data gap, and
    // answering from the event's denormalized copy hides a broken venue row
    // behind a search result that looks correct.
    raw
      .prepare(
        `INSERT INTO venues (id,name,slug,city,state) VALUES ('v-nostate','Mystery Hall','mystery-hall','?',NULL)`
      )
      .run();
    seedEvent("venue-without-state", "v-nostate", "ME");
    expect(await idsForState("ME")).toEqual([]);
  });

  it("is case-insensitive on both sides", async () => {
    seedEvent("lower-me", null, "me");
    expect(await idsForState("ME")).toContain("lower-me");
    expect(await idsForState("me")).toContain("lower-me");
  });
});
