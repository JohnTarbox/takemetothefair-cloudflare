/**
 * OPE-456 — the derived-milestone GENERATOR.
 *
 * drizzle/0222 wrote nine crossings once and nothing wrote the next ones, so the
 * chart went quiet between badges from 2026-08-20 on. These pin the three rules
 * the daily writer lives under — settled days only, never a second row for a
 * threshold, never a badge — each beside a positive landmark, because a writer
 * that silently wrote nothing would pass every negative assertion here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { gscDailyTotals, gscMilestoneEmails } from "@/lib/db/schema";
import { deriveCrossings } from "../derive-gsc-milestones";
import {
  DERIVED_DATE_SOURCE,
  DERIVED_SOURCE,
  milestoneLadder,
  recordDerivedMilestones,
} from "../record-derived-milestones";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    const pk = c.primary
      ? type === "INTEGER"
        ? " PRIMARY KEY AUTOINCREMENT"
        : " PRIMARY KEY"
      : "";
    return `  ${c.name} ${type}${pk}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

/** D1's batch() is not in the better-sqlite3 driver; run statements in order. */
function withBatch<T extends object>(d: T): T {
  return Object.assign(d, {
    batch: async (stmts: Array<PromiseLike<unknown>>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s);
      return out;
    },
  });
}

const PROPERTY = "sc-domain:meetmeatthefair.com";

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
});

function day(i: number): string {
  return new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
}

/** `n` consecutive days from 2026-08-01, clicks per day from `perDay`. */
async function seedDailies(n: number, perDay: (i: number) => number, site = PROPERTY) {
  for (let i = 0; i < n; i++) {
    await db.insert(gscDailyTotals).values({
      siteUrl: site,
      date: day(i),
      clicks: perDay(i),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
  }
}

async function milestones() {
  return db
    .select({
      threshold: gscMilestoneEmails.threshold,
      reachedDate: gscMilestoneEmails.reachedDate,
      emailDate: gscMilestoneEmails.emailDate,
      source: gscMilestoneEmails.source,
      reachedDateSource: gscMilestoneEmails.reachedDateSource,
    })
    .from(gscMilestoneEmails)
    .orderBy(gscMilestoneEmails.threshold);
}

describe("OPE-456 — derived milestone generator", () => {
  it("records a crossing as derived, never as a badge (landmark: a row IS written)", async () => {
    // 50/day: the 28-day window first reaches 1,400 on day index 27 (2026-08-28).
    await seedDailies(40, () => 50);
    const now = new Date("2026-09-30T06:00:00Z"); // settled through 09-22, all 40 days

    const r = await recordDerivedMilestones(db as never, now);

    expect(r.inserted.map((c) => c.threshold)).toEqual([1000]);
    expect(await milestones()).toEqual([
      {
        threshold: 1000,
        reachedDate: "2026-08-28",
        emailDate: "2026-08-28",
        source: DERIVED_SOURCE,
        reachedDateSource: DERIVED_DATE_SOURCE,
      },
    ]);
    expect(DERIVED_SOURCE).not.toBe("google_search_console_email");
  });

  it("does not derive from a day still inside the sync's revision window", async () => {
    // Flat 30/day (840 per window) until a spike on day 35 lifts the window
    // past 1,000 on 2026-09-05 exactly.
    await seedDailies(40, (i) => (i === 35 ? 500 : 30));
    const crossedOn = "2026-09-05";

    // 09-12: settled through 09-04 — the crossing day is 7 days old, still revisable.
    const early = await recordDerivedMilestones(db as never, new Date("2026-09-12T06:00:00Z"));
    expect(early.settledThrough).toBe("2026-09-04");
    expect(early.inserted).toEqual([]);
    expect(await milestones()).toEqual([]);

    // The next day it has settled, and it is recorded on its true date.
    const next = await recordDerivedMilestones(db as never, new Date("2026-09-13T06:00:00Z"));
    expect(next.inserted.map((c) => [c.threshold, c.reachedDate])).toEqual([[1000, crossedOn]]);
  });

  it("never writes a second row for a threshold that already has one, whatever its date", async () => {
    await seedDailies(40, () => 100); // window 2,800: crosses 1K and 2K
    // A Google badge for 2K, dated differently from the derived crossing — the
    // unique index (keyed on email_date) would NOT stop a duplicate here.
    await db.insert(gscMilestoneEmails).values({
      metric: "clicks",
      windowDays: 28,
      threshold: 2000,
      reachedDate: "2026-08-29",
      emailDate: "2026-08-31",
      siteUrl: "https://meetmeatthefair.com/",
      source: "google_search_console_email",
      createdAt: new Date("2026-08-31T00:00:00Z"),
    });

    const r = await recordDerivedMilestones(db as never, new Date("2026-09-30T06:00:00Z"));

    expect(r.inserted.map((c) => c.threshold)).toEqual([1000]); // landmark
    expect(r.alreadyRecorded).toBe(1);
    const rows = await milestones();
    expect(rows.filter((m) => m.threshold === 2000)).toHaveLength(1);
    expect(rows.find((m) => m.threshold === 2000)?.source).toBe("google_search_console_email");
  });

  it("is a no-op on a second run", async () => {
    await seedDailies(40, () => 100);
    const now = new Date("2026-09-30T06:00:00Z");
    const first = await recordDerivedMilestones(db as never, now);
    expect(first.inserted).toHaveLength(2);
    const second = await recordDerivedMilestones(db as never, now);
    expect(second.inserted).toEqual([]);
    expect(await milestones()).toHaveLength(2);
  });

  it("refuses to sum two GSC properties together", async () => {
    await seedDailies(40, () => 50);
    await seedDailies(40, () => 50, "https://meetmeatthefair.com/");
    await expect(
      recordDerivedMilestones(db as never, new Date("2026-09-30T06:00:00Z"))
    ).rejects.toThrow(/2 properties/);
    expect(await milestones()).toEqual([]);
  });

  it("the ladder is ascending, starts at 1,000 and holds the 18K–21K gap this was filed about", () => {
    const l = milestoneLadder();
    expect(l[0]).toBe(1000);
    expect([...l].sort((a, b) => a - b)).toEqual(l);
    expect(new Set(l).size).toBe(l.length);
    for (const t of [18000, 19000, 20000, 21000, 23000, 50000, 55000, 100000]) {
      expect(l).toContain(t);
    }
  });
});

describe("deriveCrossings — a missing day cannot pull a crossing early", () => {
  it("skips a 28-row window that spans more than 28 calendar days", () => {
    // 28 rows of 50 = 1,400, but day index 10 is missing, so the first 28 rows
    // span 29 days. The true first full window ends one row later.
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: day(i), clicks: 50 })).filter(
      (_, i) => i !== 10
    );
    const c = deriveCrossings(rows, [1400], 28);
    // Rows 0..28 (dates idx 0..28 minus 10) span 29 days → skipped; the first
    // consecutive 28-day window is idx 11..38, which the series never reaches.
    expect(c).toEqual([]);
    // Landmark: the same series without the gap crosses.
    const full = Array.from({ length: 30 }, (_, i) => ({ date: day(i), clicks: 50 }));
    expect(deriveCrossings(full, [1400], 28).map((x) => x.reachedDate)).toEqual(["2026-08-28"]);
  });
});
