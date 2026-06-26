/**
 * K34 / EH3 P3.1 — createOccurrenceForSeries guard paths (series_not_found,
 * year-bucketed idempotency). The happy-path insert is a byte-identical
 * extraction of the prior `/api/admin/occurrences/create` route body; the pure
 * field inheritance is covered by create-occurrence-core.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { createOccurrenceForSeries } from "../create-occurrence";

const SCHEMA_SQL = `
  CREATE TABLE event_series (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    venue_id TEXT,
    promoter_id TEXT,
    recurrence_rule TEXT,
    description TEXT,
    image_url TEXT,
    categories TEXT,
    tags TEXT,
    primary_audience TEXT NOT NULL DEFAULT 'PUBLIC',
    public_access TEXT NOT NULL DEFAULT 'OPEN'
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    series_id TEXT,
    slug TEXT NOT NULL,
    start_date INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

function seedSeries(id: string, promoterId: string | null) {
  raw
    .prepare(
      `INSERT INTO event_series (id, name, promoter_id, primary_audience, public_access) VALUES (?, ?, ?, 'PUBLIC', 'OPEN')`
    )
    .run(id, "Cheshire Fair", promoterId);
}
function seedSibling(id: string, seriesId: string, slug: string, startIso: string | null) {
  raw
    .prepare(`INSERT INTO events (id, series_id, slug, start_date) VALUES (?, ?, ?, ?)`)
    .run(id, seriesId, slug, startIso ? Math.floor(new Date(startIso).getTime() / 1000) : null);
}

describe("createOccurrenceForSeries — guards", () => {
  it("returns series_not_found for an unknown series", async () => {
    const res = await createOccurrenceForSeries(db as never, { seriesId: "nope", year: 2027 });
    expect(res).toEqual({ created: false, reason: "series_not_found", year: 2027 });
  });

  it("is idempotent by year: returns occurrence_exists when a sibling already has that year (via start_date)", async () => {
    seedSeries("s1", "promoter1");
    seedSibling("e2026", "s1", "cheshire-fair-2026", "2026-08-01T00:00:00Z");
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2026 });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2026",
      year: 2026,
    });
  });

  it("detects an existing year from a -YYYY slug suffix when start_date is null", async () => {
    seedSeries("s1", "promoter1");
    seedSibling("e2027", "s1", "cheshire-fair-2027", null);
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(res).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "e2027",
      year: 2027,
    });
  });

  it("returns promoter_required when the series has no default promoter and none is supplied", async () => {
    seedSeries("s1", null);
    const res = await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(res).toEqual({ created: false, reason: "promoter_required", year: 2027 });
  });
});
