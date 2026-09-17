/**
 * OPE-1058 scope 2 — the rewrite, end to end against a real SQLite.
 *
 * Mocking the DB would prove the mapping (already unit-tested) and nothing about
 * the properties that matter for a bulk mutation: that a dry run writes NOTHING,
 * that every changed row leaves a reversal record, that a second run is a no-op,
 * and that the read-back reports what actually remains rather than what the code
 * believes it wrote (docs/bulk-mutation-discipline.md).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { events, eventCategoryMigrationLog } from "@/lib/db/schema";

let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
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

vi.mock("@/lib/api/with-auth", () => ({
  // Identity: the auth wrapper has its own tests. The handler receives the db
  // this test built.
  withAuthorized:
    (handler: (ctx: { request: Request; db: unknown }) => Promise<Response>) =>
    (request: Request) =>
      handler({ request, db }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const { POST } = await import("../route");

const call = async (body: Record<string, unknown>) => {
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("https://x.test/api/admin/events/category-cleanup", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return (await res.json()) as {
    planned: number;
    written: number;
    per_value: Record<string, number>;
    still_off_list: Array<{ slug: string; values: string[] }>;
  };
};

const seed = (id: string, categories: string[], tags: string[] = []) =>
  db
    .insert(events)
    .values({
      id,
      name: id,
      slug: id,
      promoterId: "p1",
      categories: JSON.stringify(categories),
      tags: JSON.stringify(tags),
    } as never)
    .run();

const row = (id: string) =>
  db
    .select({ c: events.categories, t: events.tags })
    .from(events)
    .where(undefined)
    .all()
    .find((_, i) => i === 0) &&
  db
    .select()
    .from(events)
    .all()
    .find((e) => e.id === id)!;

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
});

describe("POST /api/admin/events/category-cleanup", () => {
  it("DRY RUN by default: plans the change and writes nothing", async () => {
    seed("e1", ["Craft Fsir", "Family-Friendly"], ["imported"]);

    const out = await call({});

    expect(out.planned).toBe(1);
    expect(out.written).toBe(0);
    expect(out.per_value).toEqual({ "Craft Fsir": 1, "Family-Friendly": 1 });
    // Untouched.
    expect(JSON.parse(row("e1")!.categories!)).toEqual(["Craft Fsir", "Family-Friendly"]);
    expect(db.select().from(eventCategoryMigrationLog).all()).toHaveLength(0);
    // The read-back still reports it as off-list — a dry run does not pretend.
    expect(out.still_off_list.map((s) => s.slug)).toEqual(["e1"]);
  });

  it("apply: rewrites categories, rescues the tag, and logs before/after", async () => {
    seed("e1", ["Craft Fsir", "Family-Friendly"], ["imported"]);

    const out = await call({ apply: true });

    expect(out.written).toBe(1);
    expect(JSON.parse(row("e1")!.categories!)).toEqual(["Craft Fair"]);
    expect(JSON.parse(row("e1")!.tags!)).toEqual(["imported", "family-friendly"]);

    const log = db.select().from(eventCategoryMigrationLog).all();
    expect(log).toHaveLength(1);
    expect(log[0].eventId).toBe("e1");
    expect(JSON.parse(log[0].categoriesBefore)).toEqual(["Craft Fsir", "Family-Friendly"]);
    expect(JSON.parse(log[0].categoriesAfter)).toEqual(["Craft Fair"]);
    // Read back AFTER the write: nothing off-list survives.
    expect(out.still_off_list).toEqual([]);
  });

  it("is idempotent — a second apply changes nothing and does not double-log", async () => {
    seed("e1", ["Cultural"], []);
    await call({ apply: true });
    const second = await call({ apply: true });

    expect(second.planned).toBe(0);
    expect(second.written).toBe(0);
    expect(db.select().from(eventCategoryMigrationLog).all()).toHaveLength(1);
    expect(JSON.parse(row("e1")!.categories!)).toEqual(["Cultural Festival"]);
  });

  it("resumes a partial run: an audit row already present does not abort the batch", async () => {
    // The shape a crash leaves behind — the log landed, the UPDATE did not.
    // Without ON CONFLICT DO NOTHING the re-run dies on the primary key and the
    // row stays wrong forever, which is the partial-success landmine
    // docs/bulk-mutation-discipline.md is about.
    seed("e1", ["Cultural"], []);
    db.insert(eventCategoryMigrationLog)
      .values({
        id: "ope1058-e1",
        eventId: "e1",
        categoriesBefore: JSON.stringify(["Cultural"]),
        categoriesAfter: JSON.stringify(["Cultural Festival"]),
        tagsBefore: "[]",
        tagsAfter: "[]",
        migratedAt: new Date(),
      } as never)
      .run();

    const out = await call({ apply: true });

    expect(out.written).toBe(1);
    expect(JSON.parse(row("e1")!.categories!)).toEqual(["Cultural Festival"]);
    expect(db.select().from(eventCategoryMigrationLog).all()).toHaveLength(1);
  });

  it("leaves a clean row alone and never logs it", async () => {
    seed("clean", ["Craft Fair", "Festival"], ["x"]);
    const out = await call({ apply: true });
    expect(out.planned).toBe(0);
    expect(db.select().from(eventCategoryMigrationLog).all()).toHaveLength(0);
  });

  it("reports a value nobody anticipated instead of dropping it", async () => {
    seed("odd", ["Craft Fair", "Something Nobody Predicted"], []);
    const out = await call({ apply: true });
    expect(out.still_off_list).toEqual([{ slug: "odd", values: ["Something Nobody Predicted"] }]);
  });
});
