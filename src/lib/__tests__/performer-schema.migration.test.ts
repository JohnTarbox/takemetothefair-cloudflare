/**
 * OPE-112 — validates the performer-tables migration (drizzle/0152) against its
 * key acceptance criterion: the event_performers UNIQUE index INCLUDES
 * performance_start, so a performer can appear multiple times at one event
 * (Sat 3 PM + Sun 10 AM, or twice the same day) without violating it — whereas an
 * exact-duplicate appearance IS rejected. Also documents the NULL-distinct caveat.
 *
 * Execs the real migration file (foreign_keys stays OFF, SQLite's default, so the
 * FK parent tables needn't exist for this constraint test).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const MIGRATION = resolve(process.cwd(), "drizzle/0152_ope112_performer_tables.sql");

let raw: InstanceType<typeof Database>;

function insertAppearance(
  overrides: Partial<{
    id: string;
    event_id: string;
    performer_id: string;
    event_day_id: string | null;
    performance_start: number | null;
  }> = {}
) {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    event_id: overrides.event_id ?? "e1",
    performer_id: overrides.performer_id ?? "p1",
    event_day_id: overrides.event_day_id ?? "d1",
    performance_start:
      overrides.performance_start === undefined ? 1000 : overrides.performance_start,
  };
  raw
    .prepare(
      `INSERT INTO event_performers (id, event_id, performer_id, event_day_id, performance_start, status)
       VALUES (@id, @event_id, @performer_id, @event_day_id, @performance_start, 'CONFIRMED')`
    )
    .run(row);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(readFileSync(MIGRATION, "utf8"));
  // This suite validates the UNIQUE index only; the FK parent tables (users,
  // events, event_days) aren't created here, so disable FK enforcement (which
  // otherwise resolves parents at statement-prepare time).
  raw.pragma("foreign_keys = OFF");
});

describe("performer tables migration (OPE-112)", () => {
  it("creates all three tables + the appearance unique index", () => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(["performers", "event_performers", "performer_slug_history"])
    );
    const idx = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_event_performers_unique'"
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it("allows a performer to appear twice the same day (different performance_start)", () => {
    insertAppearance({ performance_start: 1000 });
    // Same event/performer/day, later set time — must NOT collide.
    expect(() => insertAppearance({ performance_start: 2000 })).not.toThrow();
    const count = (raw.prepare("SELECT COUNT(*) c FROM event_performers").get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("rejects an EXACT-duplicate appearance (same event/performer/day/start)", () => {
    insertAppearance({ performance_start: 1000 });
    expect(() => insertAppearance({ performance_start: 1000 })).toThrow(/UNIQUE/i);
  });

  it("does NOT constrain two NULL-start appearances (the app-dedupe caveat)", () => {
    // SQLite treats NULLs as distinct in a UNIQUE index — so this is allowed and
    // Phase 1's tool logic must dedupe exact-duplicate NULL-start appearances.
    insertAppearance({ performance_start: null });
    expect(() => insertAppearance({ performance_start: null })).not.toThrow();
    const count = (raw.prepare("SELECT COUNT(*) c FROM event_performers").get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("enforces status default PENDING and unique performer slug", () => {
    raw
      .prepare("INSERT INTO event_performers (id, event_id, performer_id) VALUES ('x','e1','p1')")
      .run();
    expect(
      (raw.prepare("SELECT status FROM event_performers WHERE id='x'").get() as { status: string })
        .status
    ).toBe("PENDING");

    raw.prepare("INSERT INTO performers (id, name, slug) VALUES ('p1','Mr Drew','mr-drew')").run();
    expect(() =>
      raw.prepare("INSERT INTO performers (id, name, slug) VALUES ('p2','Other','mr-drew')").run()
    ).toThrow(/UNIQUE/i);
  });
});
