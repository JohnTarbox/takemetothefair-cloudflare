/**
 * OPE-581 — the series-occurrence write path dropped caller provenance.
 *
 * ## Why there was no test to fail
 *
 * `create-occurrence.test.ts` covers only the guard paths — its `events` table
 * has seven columns, so the happy-path INSERT could never run there. Its own
 * docblock says the insert is "a byte-identical extraction of the prior route
 * body" and leaves it uncovered. That is how a write path shipped with five
 * fields silently missing: nothing ever executed it.
 *
 * ## What actually reproduced, measured on prod 2026-08-27
 *
 * Exactly ONE row in production was written by this route — Yarmouth Clam
 * Festival 2027 (`dec142eb`, TENTATIVE + source_name 'series-occurrence'). It
 * confirms three of the six reported symptoms and refutes two:
 *
 *   NULL source_url                    CONFIRMED
 *   ingestion_method 'admin_manual'    CONFIRMED
 *   slug 'yarmouth-clam-festival-2027-2027'  CONFIRMED (doubled year)
 *   categories []                      NOT reproduced — has ["Festival","Food Festival"]
 *   tags []                            NOT reproduced — has 6 tags
 *
 * The categories/tags inherit from the series and were fine because that series
 * HAD them. The latent bug is real — a series with empty taxonomy stamps `[]`
 * onto every occurrence, and the caller's classification is ignored either way —
 * so the override is still worth having. It is a latent fix, not an observed one.
 *
 * (The row the ticket cites, Provincetown 2027, is PENDING with
 * `daily-discovery` provenance and a correct slug. This route writes TENTATIVE,
 * so that row never came through here and none of its six symptoms are real.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import {
  events as eventsTable,
  eventSeries as eventSeriesTable,
  eventDays as eventDaysTable,
  adminActions as adminActionsTable,
} from "../../db/schema";
import { createOccurrenceForSeries } from "../create-occurrence";

/**
 * The `events` DDL is GENERATED from the Drizzle schema rather than hand-written.
 *
 * The first version of this harness listed columns by hand and failed five
 * times in a row, each time naming one more column the insert touches
 * (`state_code`, `is_statewide`, `public_start_date`…). Every one of those was
 * a column with a schema-level default that Drizzle includes in the INSERT.
 *
 * Hand-listing is not just tedious here, it is wrong: the next column added to
 * `events` would break this file for a reason that has nothing to do with what
 * it tests. Deriving it means the harness tracks the schema by construction.
 */
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [eventSeriesTable, eventsTable, eventDaysTable, adminActionsTable]) {
    raw.exec(ddlFor(t));
  }
  db = drizzle(raw, { schema });
});

function seedSeries(
  opts: { categories?: string | null; tags?: string | null; name?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO event_series (id, name, promoter_id, categories, tags, primary_audience, public_access)
       VALUES ('s1', ?, 'p1', ?, ?, 'PUBLIC', 'OPEN')`
    )
    .run(opts.name ?? "Yarmouth Clam Festival", opts.categories ?? null, opts.tags ?? null);
}

const row = () =>
  raw.prepare("SELECT * FROM events WHERE series_id = 's1'").get() as Record<string, unknown>;

describe("provenance reaches the row (the OPE-491 fix this route bypassed)", () => {
  it("persists a caller source_url instead of NULLing it", async () => {
    seedSeries();
    await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      sourceUrl: "https://clamfestival.org/",
      sourceName: "daily-discovery",
      ingestionMethod: "web_research",
    });
    expect(row().source_url).toBe("https://clamfestival.org/");
    expect(row().source_name).toBe("daily-discovery");
    expect(row().ingestion_method).toBe("web_research");
  });

  it("still defaults when the caller supplies nothing — the rollover case", async () => {
    // K27 rollover calls this with no provenance and must keep its old
    // behaviour; the fix must not force every caller to pass provenance.
    seedSeries();
    await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(row().source_name).toBe("series-occurrence");
    expect(row().ingestion_method).toBe("admin_manual");
    expect(row().source_url).toBeNull();
  });
});

describe("the doubled-year slug", () => {
  it("does not append a year the name already ends with", async () => {
    // The exact prod defect: yarmouth-clam-festival-2027-2027.
    seedSeries();
    const res = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      overrides: { name: "Yarmouth Clam Festival 2027" },
    });
    expect(res).toMatchObject({ created: true, slug: "yarmouth-clam-festival-2027" });
  });

  it("still appends when the name does NOT carry the year", async () => {
    seedSeries();
    const res = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      overrides: { name: "Yarmouth Clam Festival" },
    });
    expect(res).toMatchObject({ slug: "yarmouth-clam-festival-2027" });
  });

  it("appends when the name ends in a DIFFERENT number", async () => {
    // Guards the narrow match: only the year being stamped is skipped, so an
    // event legitimately named for another number keeps its suffix.
    seedSeries();
    const res = await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      overrides: { name: "Route 66 Festival 1955" },
    });
    expect(res).toMatchObject({ slug: "route-66-festival-1955-2027" });
  });
});

describe("taxonomy: caller wins, absence still inherits", () => {
  it("a caller's categories override the series defaults", async () => {
    seedSeries({ categories: '["Festival"]' });
    await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      overrides: { categories: '["Cultural Festival","Food Festival"]' },
    });
    expect(row().categories).toBe('["Cultural Festival","Food Festival"]');
  });

  it("omitting categories still inherits the series — the rollover contract", async () => {
    // ⚠️ The regression that would matter most. If absence were treated as
    // "none", every K27 rollover would blank the taxonomy it should carry.
    seedSeries({ categories: '["Festival","Food Festival"]', tags: '["clam","maine"]' });
    await createOccurrenceForSeries(db as never, { seriesId: "s1", year: 2027 });
    expect(row().categories).toBe('["Festival","Food Festival"]');
    expect(row().tags).toBe('["clam","maine"]');
  });

  it("an empty-taxonomy series no longer forces empty categories on the occurrence", async () => {
    // The latent bug: inheritance is only as good as the series row. This is
    // the shape that manufactures the admin uncategorized queue's own input.
    seedSeries({ categories: null });
    await createOccurrenceForSeries(db as never, {
      seriesId: "s1",
      year: 2027,
      overrides: { categories: '["Cultural Festival"]' },
    });
    expect(row().categories).toBe('["Cultural Festival"]');
  });
});
