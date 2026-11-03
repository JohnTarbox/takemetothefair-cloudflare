/**
 * OPE-1389 / OPE-1390 — the admin event PATCH, end to end against a real SQLite.
 *
 *  - OPE-1389: a save that never mentions categories/tags/status/featured/…
 *    leaves them exactly as stored (zod 4 used to fill them from the CREATE
 *    defaults, so the edit form — which never sends categories/tags — wiped
 *    both to "[]" on every save).
 *  - CLB4: prices are dollars on the wire and cents in the row, both ways.
 *  - DUP2: the OPE-423 tombstone gate and the OPE-244 approval gate apply here
 *    exactly as on the approve route.
 *  - DUP3: a rename goes through planSlugRename — collision suffix + an
 *    event_slug_history row in the same batch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { events, eventSlugHistory } from "@/lib/db/schema";

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

async function patch(id: string, body: Record<string, unknown>) {
  const res = await (
    PATCH as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
  )(
    new Request(`https://x.test/api/admin/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = (id: string) => db.select().from(events).where(eq(events.id, id)).get()!;

function seed(id: string, extra: Record<string, unknown> = {}) {
  db.insert(events)
    .values({
      id,
      name: `Event ${id}`,
      slug: `event-${id}`,
      promoterId: "p1",
      venueId: "v1",
      status: "DRAFT",
      categories: JSON.stringify(["Craft Fair", "Festival"]),
      tags: JSON.stringify(["cape-cod", "juried"]),
      featured: true,
      commercialVendorsAllowed: false,
      isStatewide: false,
      imageFocalX: 0.2,
      imageFocalY: 0.8,
      ...extra,
    } as never)
    .run();
}

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
});

describe("OPE-1389 — a PATCH writes only the keys it was sent", () => {
  it("an edit-form-shaped save (no categories/tags) leaves categories and tags untouched", async () => {
    seed("e1");
    const res = await patch("e1", { description: "Updated copy", status: "DRAFT" });
    expect(res.status).toBe(200);
    const r = row("e1");
    expect(JSON.parse(r.categories!)).toEqual(["Craft Fair", "Festival"]);
    expect(JSON.parse(r.tags!)).toEqual(["cape-cod", "juried"]);
    expect(r.description).toBe("Updated copy");
  });

  it("an unrelated one-field save does not reset status / featured / commercial / focal point", async () => {
    seed("e1", { status: "PENDING" });
    await patch("e1", { description: "x" });
    const r = row("e1");
    expect(r.status).toBe("PENDING");
    expect(r.featured).toBe(true);
    expect(r.commercialVendorsAllowed).toBe(false);
    expect(r.imageFocalX).toBe(0.2);
    expect(r.imageFocalY).toBe(0.8);
  });

  it("an explicit [] still clears categories", async () => {
    seed("e1");
    await patch("e1", { categories: [] });
    expect(JSON.parse(row("e1").categories!)).toEqual([]);
  });
});

describe("OPE-1390 CLB4 — prices: dollars on the wire, cents in the row", () => {
  it("PATCH stores cents and the response/GET read back dollars", async () => {
    seed("e1");
    const res = await patch("e1", {
      ticketPriceMin: 5,
      ticketPriceMax: 12.5,
      vendorFeeMin: 40,
      vendorFeeMax: 75.25,
    });
    expect(res.status).toBe(200);
    const r = row("e1");
    expect(r.ticketPriceMinCents).toBe(500);
    expect(r.ticketPriceMaxCents).toBe(1250);
    expect(r.vendorFeeMinCents).toBe(4000);
    expect(r.vendorFeeMaxCents).toBe(7525);
    expect(res.body.ticketPriceMin).toBe(5);
    expect(res.body.vendorFeeMax).toBe(75.25);
  });

  it("null clears a price; an unsent price is left alone", async () => {
    seed("e1", { ticketPriceMinCents: 1000, vendorFeeMinCents: 2000 });
    await patch("e1", { ticketPriceMin: null });
    const r = row("e1");
    expect(r.ticketPriceMinCents).toBeNull();
    expect(r.vendorFeeMinCents).toBe(2000);
  });
});

describe("OPE-1390 DUP2 — tombstone + approval gates", () => {
  it("refuses status APPROVED on a merged tombstone (422, nothing written)", async () => {
    seed("dead", { status: "REJECTED", mergedInto: "keeper", slug: "event-dead-merged-abcd1234" });
    const res = await patch("dead", { status: "APPROVED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("merged_tombstone");
    expect(row("dead").status).toBe("REJECTED");
  });

  it("refuses a rename of a merged tombstone", async () => {
    seed("dead", { status: "REJECTED", mergedInto: "keeper", slug: "event-dead-merged-abcd1234" });
    const res = await patch("dead", { name: "Brand New Name" });
    expect(res.status).toBe(422);
    expect(row("dead").slug).toBe("event-dead-merged-abcd1234");
  });

  it("still allows a form save of a tombstone that re-sends its own name and REJECTED", async () => {
    seed("dead", { status: "REJECTED", mergedInto: "keeper", slug: "event-dead-merged-abcd1234" });
    const res = await patch("dead", {
      name: "Event dead",
      status: "REJECTED",
      description: "audit note",
    });
    expect(res.status).toBe(200);
    expect(row("dead").slug).toBe("event-dead-merged-abcd1234");
  });

  it("refuses APPROVED for an event with no venue and not statewide", async () => {
    seed("nov", { venueId: null, isStatewide: false, stateCode: "MA" });
    const res = await patch("nov", { status: "APPROVED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("no_location");
    expect(row("nov").status).toBe("DRAFT");
  });

  it("allows APPROVED when the same PATCH links a venue", async () => {
    seed("nov", { venueId: null, isStatewide: false, stateCode: "MA" });
    const res = await patch("nov", { status: "APPROVED", venueId: "v9" });
    expect(res.status).toBe(200);
    expect(row("nov").status).toBe("APPROVED");
  });

  it("refuses un-linking the venue of an APPROVED event", async () => {
    seed("ok", { status: "APPROVED" });
    const res = await patch("ok", { venueId: null });
    expect(res.status).toBe(422);
    expect(row("ok").venueId).toBe("v1");
  });
});

describe("OPE-1390 DUP3 — rename through planSlugRename", () => {
  it("writes event_slug_history in the same save, with the collision suffix", async () => {
    seed("other", { name: "Harvest Fair", slug: "harvest-fair" });
    seed("e1");
    const res = await patch("e1", { name: "Harvest Fair" });
    expect(res.status).toBe(200);
    expect(row("e1").slug).toBe("harvest-fair-2");
    const hist = db.select().from(eventSlugHistory).all();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      eventId: "e1",
      oldSlug: "event-e1",
      newSlug: "harvest-fair-2",
      changedBy: "admin-1",
    });
  });

  it("re-sending an unchanged name does not move a suffixed slug or write history", async () => {
    seed("other", { name: "Harvest Fair", slug: "harvest-fair" });
    seed("e1", { name: "Harvest Fair", slug: "harvest-fair-1" });
    const res = await patch("e1", { name: "Harvest Fair", description: "d" });
    expect(res.status).toBe(200);
    expect(row("e1").slug).toBe("harvest-fair-1");
    expect(db.select().from(eventSlugHistory).all()).toHaveLength(0);
  });
});
