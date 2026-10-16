/**
 * OPE-1393 (CLB5) — an operator edit through the admin event PATCH to a field
 * the scraper sync writes turns sync OFF, so the next sync cannot revert it.
 * Real route, real SQLite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { and, eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, events } from "@/lib/db/schema";

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
  withAuth:
    (
      _opts: unknown,
      handler: (ctx: {
        request: Request;
        db: unknown;
        session: unknown;
        params: unknown;
      }) => Promise<Response>
    ) =>
    async (request: Request, ctx: { params: Promise<unknown> }) =>
      handler({
        request,
        db,
        session: { user: { id: "admin-1", role: "ADMIN" } },
        params: await ctx.params,
      }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}) }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => undefined),
  indexNowUrlFor: () => "https://x.test/",
}));
vi.mock("@/lib/approval-notification", () => ({ notifyApprovalIfNeeded: vi.fn() }));
vi.mock("@/lib/queues/producers", () => ({ enqueueSyndicationChange: vi.fn() }));
vi.mock("@/lib/content-links-sync", () => ({ repairBlogLinksForSlugChange: vi.fn() }));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn() }));
vi.mock("@/lib/syndication/outbox", () => ({ eventSyndicationStatements: () => [] }));

const { PATCH } = await import("../route");

async function patch(body: Record<string, unknown>) {
  const res = await (
    PATCH as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
  )(
    new Request("https://x.test/api/admin/events/e1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "e1" }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = () => db.select().from(events).where(eq(events.id, "e1")).get()!;
const auditPayload = () =>
  JSON.parse(
    db
      .select()
      .from(adminActions)
      .where(and(eq(adminActions.targetId, "e1"), eq(adminActions.action, "event.update")))
      .get()!.payloadJson as string
  ) as Record<string, unknown>;

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
  db.insert(events)
    .values({
      id: "e1",
      name: "Harvest Fair",
      slug: "harvest-fair",
      promoterId: "p1",
      status: "DRAFT",
      description: "Scraped description",
      ticketUrl: "https://harvestfair.example",
      sourceName: "mainefairs.net",
      sourceUrl: "https://mainefairs.example/hf",
      syncEnabled: true,
    } as never)
    .run();
});

describe("OPE-1393 — admin event PATCH turns scraper sync off on a synced-field edit", () => {
  it("a description edit sets sync_enabled=0 and says so in the response and audit", async () => {
    const res = await patch({ description: "Operator-corrected description" });
    expect(res.status).toBe(200);
    expect(row().syncEnabled).toBe(false);
    expect(row().description).toBe("Operator-corrected description");
    expect(res.body.warnings).toMatchObject({ sync_disabled: { fields: ["description"] } });
    expect(auditPayload()).toMatchObject({ sync_disabled_by_edit: ["description"] });
  });

  it("the edit form's unchanged syncEnabled:true does not keep sync on", async () => {
    await patch({ ticketUrl: "https://harvestfair.example/2026", syncEnabled: true });
    expect(row().syncEnabled).toBe(false);
  });

  it("re-saving unchanged synced values does not turn sync off", async () => {
    const res = await patch({
      description: "Scraped description",
      ticketUrl: "https://harvestfair.example",
      syncEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(row().syncEnabled).toBe(true);
    expect(
      (res.body.warnings as Record<string, unknown> | undefined)?.sync_disabled
    ).toBeUndefined();
  });

  it("an edit to a non-synced field leaves sync on", async () => {
    await patch({ vendorFeeNotes: "Booths $50" });
    expect(row().syncEnabled).toBe(true);
  });

  it("an operator explicitly turning sync ON alongside an edit wins", async () => {
    db.update(events).set({ syncEnabled: false }).where(eq(events.id, "e1")).run();
    await patch({ description: "Edited", syncEnabled: true });
    expect(row().syncEnabled).toBe(true);
  });
});
