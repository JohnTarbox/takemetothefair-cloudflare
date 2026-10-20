/**
 * OPE-1513 — a claimed promoter edits the vendor call on its OWN event.
 *
 * Real route, real SQLite; only the session is stubbed. The acceptance clauses
 * from OPE-1512 item 2: all six items settable on its own event, refused on
 * someone else's, and a one-field edit leaves every other field as stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, eventApplications, events } from "@/lib/db/schema";

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

let SESSION = { user: { id: "u-promo", email: "p@example.com", role: "PROMOTER" } };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => SESSION) }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({ ok: true, session: SESSION })),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db, getCloudflareEnv: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const { GET, PATCH } = await import("../route");

type Handler = (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function patch(id: string, body: Record<string, unknown>) {
  const res = await (PATCH as unknown as Handler)(
    new Request(`https://x.test/api/promoter/events/${id}/vendor-call`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function get(id: string) {
  const res = await (GET as unknown as Handler)(new Request("https://x.test/"), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const event = () => db.select().from(events).where(eq(events.id, "e1")).get()!;
const apps = () => db.select().from(eventApplications).all();
const audits = () => db.select().from(adminActions).all();

const DEADLINE = new Date("2026-08-01T12:00:00Z");

beforeEach(() => {
  SESSION = { user: { id: "u-promo", email: "p@example.com", role: "PROMOTER" } };
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
  // D1's batch, shimmed for better-sqlite3 (same as mcp-server/__tests__/setup-db.ts).
  (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = async (stmts) =>
    stmts.map((s) => (s as { run: () => unknown }).run());
  db.insert(schema.promoters)
    .values([
      { id: "p1", userId: "u-promo", companyName: "Mine", slug: "mine" },
      { id: "p2", userId: "u-other", companyName: "Theirs", slug: "theirs" },
    ] as never)
    .run();
  db.insert(events)
    .values([
      {
        id: "e1",
        name: "Harvest Fair",
        slug: "harvest-fair",
        promoterId: "p1",
        status: "APPROVED",
        vendorFeeMinCents: 7500,
        vendorFeeMaxCents: 12000,
        vendorFeeNotes: "10x10",
        applicationDeadline: DEADLINE,
        applicationUrl: "https://harvest.example/vendors",
      },
      { id: "e2", name: "Their Fair", slug: "their-fair", promoterId: "p2", status: "APPROVED" },
      {
        id: "e3",
        name: "Merged",
        slug: "merged-x",
        promoterId: "p1",
        status: "REJECTED",
        mergedInto: "e1",
      },
    ] as never)
    .run();
});

describe("OPE-1513 — promoter vendor call", () => {
  it("sets all six items on its own event, in the columns each surface reads", async () => {
    const res = await patch("e1", {
      applicationDeadline: "2026-11-01",
      applicationUrl: "https://harvest.example/apply",
      vendorFeeMin: 80,
      vendorFeeMax: 150,
      vendorFeeNotes: "10x10 &amp; 10x20",
      capacityStatus: "OPEN",
      categoriesWanted: ["Pottery", " woodworking "],
      categoriesFull: ["Jewelry"],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applicationDeadline: "2026-11-01",
      applicationUrl: "https://harvest.example/apply",
      vendorFeeMin: 80,
      vendorFeeMax: 150,
      vendorFeeNotes: "10x10 & 10x20",
      capacityStatus: "OPEN",
      categoriesWanted: ["Pottery", "woodworking"],
      categoriesFull: ["Jewelry"],
    });
    // events.* — what the public page's vendor block reads today.
    const e = event();
    expect(e.vendorFeeMinCents).toBe(8000);
    expect(e.vendorFeeMaxCents).toBe(15000);
    expect(e.applicationUrl).toBe("https://harvest.example/apply");
    expect(e.applicationDeadline?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    // The commercial_vendor route row — the model and the digest feed.
    const [a] = apps();
    expect(a).toMatchObject({
      eventId: "e1",
      lane: "commercial_vendor",
      department: null,
      url: "https://harvest.example/apply",
      capacityStatus: "OPEN",
      categoriesWanted: '["Pottery","woodworking"]',
    });
    // OPE-750 closes_at: Nov 1 is DST-end, so 23:59:59 EST = 04:59:59Z.
    expect(a.closesAt?.toISOString()).toBe("2026-11-02T04:59:59.000Z");
    const [audit] = audits();
    expect(audit).toMatchObject({
      action: "event_application.promoter_upsert",
      actorUserId: "u-promo",
      targetId: "e1",
    });
  });

  it("ROUND-TRIP: a one-field edit leaves every other field as stored", async () => {
    await patch("e1", { capacityStatus: "OPEN", categoriesWanted: ["Pottery"] });
    const eBefore = event();
    const aBefore = apps()[0];
    const res = await patch("e1", { categoriesFull: ["Candles"] });
    expect(res.status).toBe(200);
    expect(res.body.fieldsWritten).toEqual([
      "event_applications.categoriesFull",
      "event_applications.categoriesAsOf",
    ]);
    const eAfter = event();
    for (const k of Object.keys(eBefore) as Array<keyof typeof eBefore>) {
      if (k === "updatedAt") continue;
      expect([k, eAfter[k]]).toEqual([k, eBefore[k]]);
    }
    const aAfter = apps()[0];
    for (const k of Object.keys(aBefore) as Array<keyof typeof aBefore>) {
      if (["categoriesFull", "categoriesAsOf", "updatedAt"].includes(k)) continue;
      expect([k, aAfter[k]]).toEqual([k, aBefore[k]]);
    }
  });

  it("refuses someone else's event and a merge tombstone as 404 — writing nothing", async () => {
    for (const id of ["e2", "e3", "nope"]) {
      expect((await patch(id, { capacityStatus: "OPEN" })).status).toBe(404);
      expect((await get(id)).status).toBe(404);
    }
    expect(apps()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("a signed-in user with no promoter profile cannot write either", async () => {
    SESSION = { user: { id: "u-nobody", email: "n@example.com", role: "PROMOTER" } };
    expect((await patch("e1", { capacityStatus: "OPEN" })).status).toBe(404);
    expect(apps()).toHaveLength(0);
  });

  it("a mailto: link becomes the route row's contact email, not its url", async () => {
    const res = await patch("e1", { applicationUrl: "mailto:vendors@harvest.example" });
    expect(res.status).toBe(200);
    expect(apps()[0]).toMatchObject({ url: null, contactEmail: "vendors@harvest.example" });
    expect(event().applicationUrl).toBe("mailto:vendors@harvest.example");
  });

  it("rejects a bad request without writing: fee range vs STORED value, javascript: link, unknown key, empty", async () => {
    const cases: Array<Record<string, unknown>> = [
      { vendorFeeMax: 50 }, // stored min is $75
      { applicationUrl: "javascript:alert(1)" },
      { applicationDeadline: "2026-02-30" },
      { status: "APPROVED" }, // .strict(): not a vendor-call field
      {},
    ];
    for (const body of cases) {
      expect((await patch("e1", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(event().vendorFeeMaxCents).toBe(12000);
    expect(apps()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it("GET reads the legacy columns when no route row exists yet", async () => {
    const res = await get("e1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applicationDeadline: "2026-08-01",
      applicationUrl: "https://harvest.example/vendors",
      vendorFeeMin: 75,
      capacityStatus: "UNKNOWN",
      categoriesWanted: [],
    });
  });
});
