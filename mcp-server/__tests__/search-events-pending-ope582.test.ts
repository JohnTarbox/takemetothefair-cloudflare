/**
 * OPE-582 — `search_events` was blind to the queue discovery itself fills.
 *
 * All three dedup passes of the daily discovery task run on `search_events`,
 * which returned APPROVED + TENTATIVE only. The task parks its own output as
 * PENDING under the `needs-enrichment` gate, so every pass reported "clear" for
 * events the task had already created. Confirmed twice (2026-08-22 and
 * 2026-08-26); both times the only thing that stopped a duplicate was
 * `suggest_event`'s `exact_url` matcher, which cannot help once the same event
 * is found under a different URL.
 *
 * These run the predicate against a real SQLite database. Asserting the
 * parameter merely EXISTS would not catch the case that matters — a predicate
 * that accepts `include_statuses` and then quietly keeps filtering PENDING out.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { events } from "../src/schema.js";
import { searchEventStatusWhere, publicEventWhere } from "../src/helpers.js";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    start_date INTEGER,
    end_date INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seed(id: string, status: string, lifecycle = "SCHEDULED") {
  raw
    .prepare(`INSERT INTO events (id, name, slug, status, lifecycle_status) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `Event ${id}`, `event-${id}`, status, lifecycle);
}

const idsWhere = async (statuses?: readonly string[]) =>
  (await db.select({ id: events.id }).from(events).where(searchEventStatusWhere(statuses)))
    .map((r) => r.id)
    .sort();

describe("default behaviour is byte-for-byte unchanged", () => {
  // The ticket's first acceptance line. Eight other read sites share
  // publicEventWhere(); if the default drifted, they would start leaking.
  it("omitting the parameter returns exactly what publicEventWhere returns", async () => {
    seed("a", "APPROVED");
    seed("t", "TENTATIVE");
    seed("p", "PENDING");
    seed("d", "DRAFT");
    seed("r", "REJECTED");

    const viaDefault = await idsWhere(undefined);
    const viaPublic = (await db.select({ id: events.id }).from(events).where(publicEventWhere()))
      .map((r) => r.id)
      .sort();

    expect(viaDefault).toEqual(viaPublic);
    expect(viaDefault).toEqual(["a", "t"]);
  });

  it("an EMPTY list is treated as absent, not as 'match nothing'", async () => {
    // `include_statuses: []` from a caller building the array dynamically must
    // not silently return zero rows and read as "no duplicates found".
    seed("a", "APPROVED");
    expect(await idsWhere([])).toEqual(["a"]);
  });
});

describe("the 2026-08-26 repro — a PENDING row the dedup passes could not see", () => {
  it("surfaces PENDING when asked, which is the whole ticket", async () => {
    seed("approved-2026", "APPROVED");
    seed("pending-2027", "PENDING"); // the 678e442e row's shape
    expect(await idsWhere(["APPROVED", "TENTATIVE", "PENDING"])).toEqual([
      "approved-2026",
      "pending-2027",
    ]);
  });

  it("still hides PENDING when the caller does not ask", async () => {
    seed("approved-2026", "APPROVED");
    seed("pending-2027", "PENDING");
    expect(await idsWhere(undefined)).toEqual(["approved-2026"]);
  });

  it("can be narrowed as well as widened", async () => {
    seed("a", "APPROVED");
    seed("t", "TENTATIVE");
    expect(await idsWhere(["APPROVED"])).toEqual(["a"]);
  });
});

describe("the lifecycle filter is NOT relaxed", () => {
  it("a CANCELLED-lifecycle PENDING row is still excluded", async () => {
    // Widening the editorial status must not drag in events that are not
    // happening — they are not dedup targets, and matching one would suppress
    // a legitimate new event.
    seed("live", "PENDING", "SCHEDULED");
    seed("dead", "PENDING", "CANCELLED");
    expect(await idsWhere(["PENDING"])).toEqual(["live"]);
  });

  it("holds for the default path too", async () => {
    seed("live", "APPROVED", "SCHEDULED");
    seed("dead", "APPROVED", "CANCELLED");
    expect(await idsWhere(undefined)).toEqual(["live"]);
  });
});

describe("composability — the predicate is ANDed with the real query's filters", () => {
  it("does not swallow other conditions", async () => {
    // search_events pushes this into a conditions array alongside name/date
    // filters. A predicate that ignored its siblings would return the whole
    // table and read as a pile of false duplicates.
    seed("a", "APPROVED");
    seed("b", "APPROVED");
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(and(searchEventStatusWhere(["APPROVED"]), eq(events.id, "b")));
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });
});
