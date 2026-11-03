/**
 * OPE-1393 (CLB5) — scraper re-import and sync, against a real SQLite.
 *
 *  - POST with updateExisting: a scrape with NO venue used to write
 *    `venueId: null` over the stored venue, and a scrape with no website used
 *    to replace the stored ticket link with the source (listing) URL.
 *  - PATCH (bulk sync): a details "website" that is just the source page never
 *    replaces a stored ticket link.
 *  - Both paths still skip a row whose sync was turned off by an operator edit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { events } from "@/lib/db/schema";

let db: ReturnType<typeof drizzle<typeof schema>>;
let details: Record<string, unknown> = {};

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType().toUpperCase();
    const type = t.includes("INT") ? "INTEGER" : t.includes("REAL") ? "REAL" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

vi.mock("@/lib/api/with-auth", () => ({
  withAuth:
    (_opts: unknown, handler: (ctx: { request: Request; db: unknown }) => Promise<Response>) =>
    async (request: Request) =>
      handler({ request, db }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}), getCloudflareDb: () => db }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => undefined),
  indexNowUrlFor: () => "https://x.test/",
}));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn() }));
vi.mock("@/lib/scrapers/registry", () => ({
  getScraper: vi.fn(),
  parseSourceOptions: vi.fn(),
  getScraperRetirement: () => null,
  getDetailsScraper: () => async () => details,
}));

const { POST, PATCH } = await import("../route");

async function call(
  handler: unknown,
  method: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await (handler as (r: Request) => Promise<Response>)(
    new Request("https://x.test/api/admin/import", {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
  return (await res.json()) as Record<string, unknown>;
}

const row = (id: string) => db.select().from(events).where(eq(events.id, id)).get()!;

const SOURCE_URL = "https://mainefairs.example/listing/harvest-fair";

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
  db.insert(schema.promoters)
    .values({ id: "p1", companyName: "P", slug: "p" } as never)
    .run();
  db.insert(schema.venues)
    .values({
      id: "v1",
      name: "Fairground",
      slug: "fairground",
      city: "Union",
      state: "ME",
    } as never)
    .run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Harvest Fair",
      slug: "harvest-fair",
      promoterId: "p1",
      venueId: "v1",
      status: "APPROVED",
      ticketUrl: "https://harvestfair.example/tickets",
      sourceName: "mainefairs.net",
      sourceId: "hf-1",
      sourceUrl: SOURCE_URL,
      syncEnabled: true,
    } as never)
    .run();
  details = {};
});

function reimport(extra: Record<string, unknown> = {}) {
  return call(POST, "POST", {
    promoterId: "p1",
    updateExisting: true,
    events: [
      {
        name: "Harvest Fair",
        sourceName: "mainefairs.net",
        sourceId: "hf-1",
        sourceUrl: SOURCE_URL,
        ...extra,
      },
    ],
  });
}

describe("OPE-1393 — POST updateExisting (re-import)", () => {
  it("a scrape with no venue never nulls the stored venue", async () => {
    const res = await reimport();
    expect(res.updated).toBe(1);
    expect(row("e1").venueId).toBe("v1");
  });

  it("a scrape with no website never replaces the stored ticket link with the source URL", async () => {
    await reimport();
    expect(row("e1").ticketUrl).toBe("https://harvestfair.example/tickets");
  });

  it("a scraped website still updates the ticket link", async () => {
    await reimport({ website: "https://harvestfair.example/2026" });
    expect(row("e1").ticketUrl).toBe("https://harvestfair.example/2026");
  });

  it("the source URL is still the fallback for a row with NO ticket link", async () => {
    db.update(events).set({ ticketUrl: null }).where(eq(events.id, "e1")).run();
    await reimport();
    expect(row("e1").ticketUrl).toBe(SOURCE_URL);
  });

  it("a row whose sync was turned off is skipped entirely", async () => {
    db.update(events)
      .set({ syncEnabled: false, description: "Operator text" })
      .where(eq(events.id, "e1"))
      .run();
    const res = await reimport({ description: "Scraped text" });
    expect(res.skipped).toBe(1);
    expect(row("e1").description).toBe("Operator text");
  });
});

describe("OPE-1393 — PATCH (bulk sync)", () => {
  it("a details 'website' equal to the source page never replaces a stored ticket link", async () => {
    details = { website: SOURCE_URL, description: "New scraped description" };
    await call(PATCH, "PATCH");
    const r = row("e1");
    expect(r.description).toBe("New scraped description");
    expect(r.ticketUrl).toBe("https://harvestfair.example/tickets");
  });

  it("a real details website still updates the ticket link", async () => {
    details = { website: "https://harvestfair.example/2026" };
    await call(PATCH, "PATCH");
    expect(row("e1").ticketUrl).toBe("https://harvestfair.example/2026");
  });

  it("a sync-disabled row is never touched", async () => {
    db.update(events)
      .set({ syncEnabled: false, description: "Operator text" })
      .where(eq(events.id, "e1"))
      .run();
    details = { description: "Scraped text" };
    await call(PATCH, "PATCH");
    expect(row("e1").description).toBe("Operator text");
  });
});
