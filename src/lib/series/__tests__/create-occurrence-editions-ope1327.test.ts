/**
 * OPE-1327 — createOccurrenceForSeries on a MULTI-EDITION series, end to end
 * through the insert, against the MCP suite's full test schema
 * (mcp-server/__tests__/setup-db.ts — the DDL the WS2b schema-sync guard keeps
 * in step with packages/db-schema, including the partial unique index on
 * (series_id, edition_key) from drizzle/0356).
 *
 * Not a migration replay: replaying drizzle/ on an empty SQLite leaves `events`
 * in a pre-rebuild shape (venue_id NOT NULL, no dates_confirmed) because a few
 * 2025 table-rebuild migrations assume data. Tried first; it failed loudly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";
import { createOccurrenceForSeries } from "../create-occurrence";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

beforeEach(() => {
  ({ raw, db } = createTestDb());
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'NEAR', 'near')`).run();
});
afterEach(() => raw.close());

function seedSeries(id: string, mode: "annual" | "multi") {
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, promoter_id, edition_mode) VALUES (?, ?, 'NEAR-Fest', 'p1', ?)`
    )
    .run(id, `${id}-slug`, mode);
}
function seedMember(
  id: string,
  seriesId: string,
  startIso: string,
  opts: { key?: string | null; status?: string; mergedInto?: string | null } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, series_id, start_date, end_date, status, merged_into, edition_key)
       VALUES (?, ?, ?, 'p1', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      id,
      seriesId,
      sec(startIso),
      sec(startIso),
      opts.status ?? "APPROVED",
      opts.mergedInto ?? null,
      opts.key ?? null
    );
}
const keyOf = (id: string) =>
  (raw.prepare(`SELECT edition_key k FROM events WHERE id = ?`).get(id) as { k: string | null }).k;

describe("multi-edition series", () => {
  it("creates May AND October of one year as two occurrences, each with its own key", async () => {
    seedSeries("s", "multi");
    const may = await createOccurrenceForSeries(db as never, {
      seriesId: "s",
      year: 2027,
      overrides: { startDate: new Date("2027-05-15T16:00:00Z") },
    });
    const oct = await createOccurrenceForSeries(db as never, {
      seriesId: "s",
      year: 2027,
      overrides: { startDate: new Date("2027-10-01T16:00:00Z") },
    });
    expect(may).toMatchObject({ created: true, editionKey: "2027-05" });
    expect(oct).toMatchObject({ created: true, editionKey: "2027-10" });
    expect(keyOf((may as { occurrenceId: string }).occurrenceId)).toBe("2027-05");
    expect(keyOf((oct as { occurrenceId: string }).occurrenceId)).toBe("2027-10");
  });

  it("is idempotent on the edition key", async () => {
    seedSeries("s", "multi");
    seedMember("xli", "s", "2027-05-15T16:00:00Z", { key: "2027-05" });
    const again = await createOccurrenceForSeries(db as never, {
      seriesId: "s",
      year: 2027,
      overrides: { startDate: new Date("2027-05-20T16:00:00Z") },
    });
    expect(again).toEqual({
      created: false,
      reason: "occurrence_exists",
      existingEventId: "xli",
      year: 2027,
      editionKey: "2027-05",
    });
  });

  it("an explicit suffixed key resolves a same-month clash", async () => {
    seedSeries("s", "multi");
    seedMember("xli", "s", "2027-05-01T16:00:00Z", { key: "2027-05" });
    const r = await createOccurrenceForSeries(db as never, {
      seriesId: "s",
      year: 2027,
      editionKey: "2027-05-late",
      overrides: { startDate: new Date("2027-05-29T16:00:00Z") },
    });
    expect(r).toMatchObject({ created: true, editionKey: "2027-05-late" });
  });

  it("keys on the VENUE-zone month: 11pm Eastern on May 31 is May, though UTC is June", async () => {
    seedSeries("s", "multi");
    const r = await createOccurrenceForSeries(db as never, {
      seriesId: "s",
      year: 2027,
      overrides: { startDate: new Date("2027-06-01T03:00:00Z") },
    });
    expect(r).toMatchObject({ created: true, editionKey: "2027-05" });
  });

  it("refuses with edition_key_required: malformed key, or no key and no date", async () => {
    seedSeries("s", "multi");
    expect(
      await createOccurrenceForSeries(db as never, {
        seriesId: "s",
        year: 2027,
        editionKey: "May 2027",
      })
    ).toMatchObject({ created: false, reason: "edition_key_required" });
    expect(
      await createOccurrenceForSeries(db as never, { seriesId: "s", year: 2027 })
    ).toMatchObject({
      created: false,
      reason: "edition_key_required",
    });
  });
});

describe("siblings no longer include REJECTED rows or merge tombstones", () => {
  it("an annual series: a REJECTED 2027 row does not block the real 2027 occurrence", async () => {
    seedSeries("a", "annual");
    seedMember("rej", "a", "2027-08-01T16:00:00Z", { status: "REJECTED" });
    const r = await createOccurrenceForSeries(db as never, {
      seriesId: "a",
      year: 2027,
      overrides: { startDate: new Date("2027-08-02T16:00:00Z") },
    });
    expect(r).toMatchObject({ created: true });
  });

  it("an annual series: a merge tombstone does not block either", async () => {
    seedSeries("a", "annual");
    seedMember("keeper", "a", "2026-08-01T16:00:00Z");
    seedMember("tomb", "a", "2027-08-01T16:00:00Z", { mergedInto: "keeper", status: "REJECTED" });
    const r = await createOccurrenceForSeries(db as never, {
      seriesId: "a",
      year: 2027,
      overrides: { startDate: new Date("2027-08-02T16:00:00Z") },
    });
    expect(r).toMatchObject({ created: true });
  });

  it("an annual series still refuses a LIVE same-year sibling (unchanged)", async () => {
    seedSeries("a", "annual");
    seedMember("live", "a", "2027-08-01T16:00:00Z");
    expect(
      await createOccurrenceForSeries(db as never, { seriesId: "a", year: 2027 })
    ).toMatchObject({ created: false, reason: "occurrence_exists", existingEventId: "live" });
  });

  it("an annual series ignores edition_key and stores NULL", async () => {
    seedSeries("a", "annual");
    const r = await createOccurrenceForSeries(db as never, {
      seriesId: "a",
      year: 2028,
      editionKey: "2028-08",
      overrides: { startDate: new Date("2028-08-02T16:00:00Z") },
    });
    expect(r).toMatchObject({ created: true });
    expect(r).not.toHaveProperty("editionKey");
    expect(keyOf((r as { occurrenceId: string }).occurrenceId)).toBeNull();
  });
});
