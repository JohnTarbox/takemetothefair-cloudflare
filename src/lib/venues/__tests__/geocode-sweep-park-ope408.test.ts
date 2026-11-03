/**
 * OPE-408 rework — the nightly geocode sweep parks a venue it keeps refusing,
 * and un-parks it when the record is edited. Real SQLite, schema-derived DDL,
 * the shipped PARKED fragment and the shipped raw-SQL counter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { and, eq, is, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { venues } from "@/lib/db/schema";
import {
  GEOCODE_PARK_AFTER,
  PARKED,
  isSweepRefusal,
  recordSweepRefusal,
} from "@/lib/venues/geocode-sweep-park";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType().toUpperCase();
    const type = t.includes("INT") ? "INTEGER" : t.includes("REAL") ? "REAL" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
  const base = { city: "Freeport", state: "ME", zip: "04032", status: "ACTIVE" as const };
  db.insert(venues)
    .values([
      {
        id: "v-refused",
        name: "Hilton Garden Inn",
        slug: "hgi" as never,
        address: "5 Park St",
        ...base,
      },
      {
        id: "v-fresh",
        name: "Freeport Town Hall",
        slug: "fth" as never,
        address: "30 Main St",
        ...base,
      },
    ] as never)
    .run();
  // The production column is NOT NULL DEFAULT 0 (drizzle/0353); the derived DDL
  // carries no defaults, so start the counter where production starts it.
  raw.exec("UPDATE venues SET geocode_refusals = 0, updated_at = unixepoch('now') - 86400");
});

/** The sweep's own selection, minus paging: unpinned and NOT parked. */
const sweepable = () =>
  db
    .select({ id: venues.id })
    .from(venues)
    .where(and(isNull(venues.latitude), isNull(venues.longitude), sql`NOT ${PARKED}`))
    .all()
    .map((r) => r.id)
    .sort();

const row = (id: string) => db.select().from(venues).where(eq(venues.id, id)).all()[0];

describe("OPE-408 rework — refused venues park, edited venues come back", () => {
  it(`stays in the sweep after ${GEOCODE_PARK_AFTER - 1} refusal, parks at ${GEOCODE_PARK_AFTER}`, async () => {
    expect(sweepable()).toEqual(["v-fresh", "v-refused"]); // landmark: both start eligible
    for (let i = 1; i < GEOCODE_PARK_AFTER; i++) await recordSweepRefusal(db, "v-refused");
    expect(sweepable()).toEqual(["v-fresh", "v-refused"]);
    await recordSweepRefusal(db, "v-refused");
    expect(sweepable()).toEqual(["v-fresh"]);
    expect(row("v-refused").geocodeRefusals).toBe(GEOCODE_PARK_AFTER);
  });

  it("counting a refusal never touches updated_at (the venue's ETag / sitemap lastmod)", async () => {
    const before = raw.prepare("SELECT updated_at FROM venues WHERE id='v-refused'").get();
    await recordSweepRefusal(db, "v-refused");
    await recordSweepRefusal(db, "v-refused");
    const after = raw.prepare("SELECT updated_at FROM venues WHERE id='v-refused'").get();
    expect(after).toEqual(before);
  });

  it("editing a parked venue (e.g. correcting its address) puts it back in the sweep", async () => {
    await recordSweepRefusal(db, "v-refused");
    await recordSweepRefusal(db, "v-refused");
    expect(sweepable()).toEqual(["v-fresh"]);
    // The refusals happened yesterday; the fix happens now. A Drizzle update
    // stamps updated_at through $onUpdateFn, exactly as an admin edit would.
    raw.exec(
      "UPDATE venues SET geocode_last_refused_at = unixepoch('now') - 3600 WHERE id='v-refused'"
    );
    db.update(venues).set({ address: "5 Park Street" }).where(eq(venues.id, "v-refused")).run();
    expect(sweepable()).toEqual(["v-fresh", "v-refused"]);
  });

  it("only deterministic gate answers count; a transient error never parks", () => {
    for (const s of [
      "low-confidence",
      "no-match",
      "duplicate-with",
      "not-a-point",
      "insufficient-address",
    ]) {
      expect(isSweepRefusal(s), s).toBe(true);
    }
    for (const s of ["error", "ok", "forced", "already-geocoded"]) {
      expect(isSweepRefusal(s), s).toBe(false);
    }
  });
});
