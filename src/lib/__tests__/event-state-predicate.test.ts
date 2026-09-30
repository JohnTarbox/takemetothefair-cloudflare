/**
 * OPE-1028 — list pages and the MCP reader must answer "is this event in state
 * X?" with the same SQL.
 *
 * Two halves:
 *  1. The predicate's semantics, on each shape of state data that exists in
 *     prod — including the one that broke (`state_code` NULL, venue carries the
 *     state: 54 of 744 upcoming public events on 2026-09-15). Run both with and
 *     without a `venues` join, because several state queries have no join.
 *  2. A source scan: nothing may filter on `eq(events.stateCode, …)` directly,
 *     which is how the list pages drifted away from the reader in the first
 *     place.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as schema from "../db/schema";
import { events, venues, eventInStateWhere } from "../db/schema";
import { searchEventStateWhere } from "../../../mcp-server/src/helpers";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE venues (id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, venue_id TEXT, state_code TEXT);
    INSERT INTO venues VALUES ('vME', 'ME'), ('vNH', 'NH'), ('vNull', NULL), ('vLower', 'me');
    INSERT INTO events VALUES
      ('venue_ME_code_null',  'vME',    NULL), -- the OPE-1028 shape: must match
      ('no_venue_code_ME',    NULL,     'ME'), -- venue-less: state_code answers
      ('venue_NH_code_ME',    'vNH',    'ME'), -- disagreement: venue is authoritative
      ('venue_ME_code_ME',    'vME',    'ME'),
      ('no_venue_code_null',  NULL,     NULL),
      ('venue_nullstate_ME',  'vNull',  'ME'), -- broken venue row is not papered over
      ('venue_lowercase_me',  'vLower', NULL);
  `);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

const EXPECTED_ME = [
  "no_venue_code_ME",
  "venue_ME_code_ME",
  "venue_ME_code_null",
  "venue_lowercase_me",
];

async function idsNoJoin(where: ReturnType<typeof eventInStateWhere>) {
  const rows = await db.select({ id: events.id }).from(events).where(where);
  return rows.map((r) => r.id).sort();
}
async function idsWithJoin(where: ReturnType<typeof eventInStateWhere>) {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(where));
  return rows.map((r) => r.id).sort();
}

describe("eventInStateWhere", () => {
  it("matches the venue's state, or state_code only when there is no venue (no join)", async () => {
    expect(await idsNoJoin(eventInStateWhere("ME"))).toEqual(EXPECTED_ME.sort());
  });

  it("returns the identical set when the caller LEFT JOINs venues", async () => {
    expect(await idsWithJoin(eventInStateWhere("ME"))).toEqual(EXPECTED_ME.sort());
  });

  it("is case-insensitive on the argument", async () => {
    expect(await idsNoJoin(eventInStateWhere("me"))).toEqual(EXPECTED_ME.sort());
  });

  it("the MCP reader's predicate is the same set (it delegates)", async () => {
    expect(await idsWithJoin(searchEventStateWhere("ME"))).toEqual(EXPECTED_ME.sort());
  });

  it("landmark: the old `state_code = 'ME'` filter disagrees on this fixture", async () => {
    // Without this, a fixture that happened to have no NULL-state_code rows
    // would pass the tests above against the old predicate too.
    const old = await idsNoJoin(eq(events.stateCode, "ME") as never);
    expect(old).not.toEqual(EXPECTED_ME.sort());
    expect(old).not.toContain("venue_ME_code_null");
  });
});

describe("no source file filters on events.stateCode directly", () => {
  const ROOT = join(__dirname, "../../..");
  const SCAN = ["src", "mcp-server/src", "packages"];
  const BANNED = /eq\(\s*events\.stateCode\s*,/;

  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  }

  it("finds no `eq(events.stateCode, …)` and does scan the tree", () => {
    const files: string[] = [];
    for (const d of SCAN) walk(join(ROOT, d), files);

    const offenders: string[] = [];
    let users = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // Comments may name the banned form when explaining it; only code counts.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (BANNED.test(code)) offenders.push(relative(ROOT, f));
      if (/eventInStateWhere\(/.test(code)) users++;
    }

    expect(offenders).toEqual([]);
    // Positive landmarks: a scan that silently read nothing would also find no
    // offenders.
    expect(files.length).toBeGreaterThan(500);
    expect(users).toBeGreaterThanOrEqual(7);
  });
});
