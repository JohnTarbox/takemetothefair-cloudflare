/**
 * OPE-1680 — the promoter portal stores a vendor fee / application deadline only
 * with a `user_submitted` citation naming the organizer. Real routes, real
 * SQLite; only the session is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { events, eventDataCitations } from "@/lib/db/schema";

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

const SESSION = { user: { id: "u-promo", email: "p@example.com", role: "PROMOTER" } };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => SESSION) }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({ ok: true, session: SESSION })),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db, getCloudflareEnv: () => ({}) }));
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn() }));
vi.mock("@/lib/series/resolve-or-create-series", () => ({ attachEventToSeries: vi.fn() }));

const { POST: saveDraft } = await import("../route");
const { POST: createEvent } = await import("../../route");

async function call(
  handler: unknown,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await (handler as (r: Request) => Promise<Response>)(
    new Request(`https://x.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const draft = (b: Record<string, unknown>) => call(saveDraft, "/api/promoter/events/draft", b);

const cites = (eventId: string) =>
  db
    .select()
    .from(eventDataCitations)
    .where(eq(eventDataCitations.eventId, eventId))
    .all()
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName) || a.state.localeCompare(b.state));
const active = (eventId: string) => cites(eventId).filter((c) => c.state === "active");

const BASE = {
  venueId: "v1",
  name: "Harvest Fair",
  description: "A fair",
  startDate: "2026-09-12T12:00:00.000Z",
  endDate: "2026-09-13T12:00:00.000Z",
};

beforeEach(() => {
  logError.mockReset();
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  raw.exec("CREATE UNIQUE INDEX ux_days ON event_days (event_id, date, vendor_only)");
  db = drizzle(raw, { schema });
  db.insert(schema.promoters)
    .values({ id: "p1", userId: "u-promo", companyName: "Harvest Fair Assoc", slug: "p" } as never)
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
      venueId: "v1",
      name: "Harvest Fair",
      slug: "harvest-fair",
      promoterId: "p1",
      status: "DRAFT",
      startDate: new Date("2026-09-12T12:00:00Z"),
      endDate: new Date("2026-09-13T12:00:00Z"),
      vendorFeeMinCents: 7500,
    } as never)
    .run();
  // The fee e1 already stores, cited by an earlier save.
  db.insert(eventDataCitations)
    .values({
      id: "c-old",
      eventId: "e1",
      fieldName: "vendor_fee_min",
      value: "75",
      sourceUrl: "submission://promoter-portal/e1",
      sourceType: "user_submitted",
      state: "active",
    } as never)
    .run();
});

describe("OPE-1680 — promoter portal cites the vendor fields it stores", () => {
  it("POST /api/promoter/events: one active user_submitted row per stored field", async () => {
    const res = await call(createEvent, "/api/promoter/events", {
      ...BASE,
      vendorFeeMin: 0, // a free booth is a real value
      vendorFeeMax: 40,
      applicationDeadline: "2026-08-01T12:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    const rows = active(id);
    expect(rows.map((r) => [r.fieldName, r.value])).toEqual([
      ["application_deadline", "2026-08-01"],
      ["vendor_fee_max", "40"],
      ["vendor_fee_min", "0"],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        sourceType: "user_submitted",
        sourceUrl: `submission://promoter-portal/${id}`,
        sourceName: "Harvest Fair Assoc",
        createdBy: "u-promo",
      });
      expect(r.notes).toContain("api/promoter/events");
    }
    expect(logError).not.toHaveBeenCalled();
  });

  it("POST /api/promoter/events with no vendor fields writes no citation", async () => {
    const res = await call(createEvent, "/api/promoter/events", BASE);
    expect(res.status).toBe(201);
    expect(cites(res.body.id as string)).toEqual([]);
  });

  it("draft create cites what it stores", async () => {
    const res = await draft({
      ...BASE,
      vendorFeeMax: 120,
      applicationDeadline: "2026-07-15T12:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect(active(id).map((r) => [r.fieldName, r.value, r.sourceUrl])).toEqual([
      ["application_deadline", "2026-07-15", `submission://promoter-portal/${id}`],
      ["vendor_fee_max", "120", `submission://promoter-portal/${id}`],
    ]);
  });

  it("draft update that changes a fee supersedes the old citation: one active row", async () => {
    const res = await draft({ id: "e1", ...BASE, vendorFeeMin: 90 });
    expect(res.status).toBe(200);
    expect(cites("e1").map((c) => [c.id === "c-old" ? "old" : "new", c.value, c.state])).toEqual([
      ["new", "90", "active"],
      ["old", "75", "superseded"],
    ]);
  });

  it("draft re-save with the SAME fee writes nothing; one without fee fields writes nothing", async () => {
    expect((await draft({ id: "e1", ...BASE, vendorFeeMin: 75 })).status).toBe(200);
    expect((await draft({ id: "e1", ...BASE })).status).toBe(200);
    expect(cites("e1").map((c) => [c.id, c.state])).toEqual([["c-old", "active"]]);
    // Landmark: the same path with a changed value does write (case above),
    // and a deadline newly sent here is cited.
    expect(
      (await draft({ id: "e1", ...BASE, applicationDeadline: "2026-08-20T12:00:00.000Z" })).status
    ).toBe(200);
    expect(active("e1").map((r) => r.fieldName)).toEqual([
      "application_deadline",
      "vendor_fee_min",
    ]);
  });
});
