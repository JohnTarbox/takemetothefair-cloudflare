/**
 * OPE-1389 — the admin vendor / venue / promoter PATCH routes write only the
 * keys they were sent. Real SQLite, real routes.
 *
 * The reported shape: the Enhanced Profile panel PATCHes a vendor with a body
 * like `{ claimed: true }`; zod 4 filled `verified`, `commercial` and
 * `canSelfConfirm` from the CREATE defaults (false), and the route's
 * `!== undefined` checks wrote all three — silently un-verifying the vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { promoters, users, vendors, venues } from "@/lib/db/schema";

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

function withBatch<T extends object>(d: T): T {
  return Object.assign(d, {
    batch: async (stmts: Array<PromiseLike<unknown>>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s);
      return out;
    },
  });
}

vi.mock("@/lib/api/with-auth", () => {
  const wrap =
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
      });
  return { withAuth: wrap, withAuthorized: wrap };
});
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}) }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => undefined),
  indexNowUrlFor: () => "https://x.test/",
}));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://x.test" }));
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: vi.fn(),
  enqueueSyndicationChange: vi.fn(),
}));
vi.mock("@/lib/recommendations/engine", () => ({ markActedAllForTarget: vi.fn() }));
vi.mock("@/lib/completeness", () => ({
  recomputeVendorCompleteness: vi.fn(),
  recomputeEventCompleteness: vi.fn(),
  recomputeVenueCompleteness: vi.fn(),
  recomputePromoterCompleteness: vi.fn(),
}));
vi.mock("@/lib/enrichment-log", () => ({ logEnrichment: vi.fn() }));
vi.mock("@/lib/syndication/outbox", () => ({ venueSyndicationStatements: () => [] }));
vi.mock("@/lib/audit/record-mutation", () => ({ recordMutation: vi.fn() }));

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;

async function patch(handler: unknown, id: string, body: Record<string, unknown>) {
  const res = await (handler as Handler)(
    new Request(`https://x.test/api/admin/x/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
});

describe("PATCH /api/admin/vendors/[id] — Enhanced Profile body", () => {
  it("{claimed:true} grants Claimed and leaves verified / commercial / canSelfConfirm / products alone", async () => {
    const { PATCH } = await import("../vendors/[id]/route");
    db.insert(users)
      .values({ id: "u1", email: "owner@example.com", role: "VENDOR" } as never)
      .run();
    db.insert(vendors)
      .values({
        id: "d1",
        userId: "u1",
        businessName: "Shop",
        slug: "shop",
        verified: true,
        commercial: true,
        canSelfConfirm: true,
        claimed: false,
        products: JSON.stringify(["soap"]),
        paymentMethods: JSON.stringify(["cash"]),
        imageFocalX: 0.3,
      } as never)
      .run();

    const res = await patch(PATCH, "d1", { claimed: true });
    expect(res.status).toBe(200);

    const v = db.select().from(vendors).where(eq(vendors.id, "d1")).get()!;
    expect(v.claimed).toBe(true);
    expect(v.verified).toBe(true);
    expect(v.commercial).toBe(true);
    expect(v.canSelfConfirm).toBe(true);
    expect(JSON.parse(v.products!)).toEqual(["soap"]);
    expect(JSON.parse(v.paymentMethods!)).toEqual(["cash"]);
    expect(v.imageFocalX).toBe(0.3);
  });
});

describe("PATCH /api/admin/venues/[id]", () => {
  it("a save without amenities/status leaves them alone", async () => {
    const { PATCH } = await import("../venues/[id]/route");
    db.insert(venues)
      .values({
        id: "v1",
        name: "Hall",
        slug: "hall",
        address: "1 Main",
        city: "A",
        state: "ME",
        zip: "04000",
        amenities: JSON.stringify(["parking", "restrooms"]),
        status: "INACTIVE",
      } as never)
      .run();

    const res = await patch(PATCH, "v1", { description: "New copy" });
    expect(res.status).toBe(200);
    const v = db.select().from(venues).where(eq(venues.id, "v1")).get()!;
    expect(JSON.parse(v.amenities!)).toEqual(["parking", "restrooms"]);
    expect(v.status).toBe("INACTIVE");
    expect(v.description).toBe("New copy");
  });
});

describe("PATCH /api/admin/promoters/[id]", () => {
  it("a save without verified leaves a verified promoter verified", async () => {
    const { PATCH } = await import("../promoters/[id]/route");
    db.insert(promoters)
      .values({ id: "p1", companyName: "Acme", slug: "acme", verified: true } as never)
      .run();

    const res = await patch(PATCH, "p1", { description: "About Acme" });
    expect(res.status).toBe(200);
    const p = db.select().from(promoters).where(eq(promoters.id, "p1")).get()!;
    expect(p.verified).toBe(true);
    expect(p.description).toBe("About Acme");
  });
});
