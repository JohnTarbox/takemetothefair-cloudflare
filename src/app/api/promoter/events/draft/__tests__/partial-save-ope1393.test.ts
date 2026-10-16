/**
 * OPE-1393 (CLB7) — a promoter draft save writes only the fields it sent.
 *
 * The update branch used to rewrite the whole DRAFT row from the create schema:
 * a save that did not mention categories/tags wiped them to "[]", absent prices
 * and the application deadline became NULL, and the event days were deleted.
 * Real route, real SQLite; only the session is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { events, eventDays } from "@/lib/db/schema";

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
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn() }));
vi.mock("@/lib/series/resolve-or-create-series", () => ({ attachEventToSeries: vi.fn() }));

const { POST } = await import("../route");

async function save(body: Record<string, unknown>) {
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("https://x.test/api/promoter/events/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = () => db.select().from(events).where(eq(events.id, "e1")).get()!;
const days = () => db.select().from(eventDays).where(eq(eventDays.eventId, "e1")).all();

const START = new Date("2026-09-12T12:00:00Z");
const END = new Date("2026-09-13T12:00:00Z");
const DEADLINE = new Date("2026-08-01T12:00:00Z");

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  // insertEventDaysBatched upserts on (event_id, date, vendor_only).
  raw.exec("CREATE UNIQUE INDEX ux_days ON event_days (event_id, date, vendor_only)");
  db = drizzle(raw, { schema });
  db.insert(schema.promoters)
    .values({ id: "p1", userId: "u-promo", companyName: "P", slug: "p" } as never)
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
      description: "Original description",
      startDate: START,
      endDate: END,
      categories: JSON.stringify(["Craft Fair"]),
      tags: JSON.stringify(["juried"]),
      isStatewide: false,
      ticketPriceMinCents: 500,
      vendorFeeMinCents: 7500,
      applicationDeadline: DEADLINE,
      ticketUrl: "https://harvestfair.example",
    } as never)
    .run();
  db.insert(eventDays)
    .values({
      id: "d1",
      eventId: "e1",
      date: "2026-09-12",
      openTime: "09:00",
      closeTime: "17:00",
    } as never)
    .run();
});

describe("OPE-1393 CLB7 — promoter draft autosave writes only the fields sent", () => {
  it("a save that sends only name + description leaves everything else as stored", async () => {
    const res = await save({
      id: "e1",
      venueId: "v1",
      name: "Harvest Fair",
      description: "Edited description",
    });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.description).toBe("Edited description");
    expect(JSON.parse(r.categories as string)).toEqual(["Craft Fair"]);
    expect(JSON.parse(r.tags as string)).toEqual(["juried"]);
    expect(r.ticketPriceMinCents).toBe(500);
    expect(r.vendorFeeMinCents).toBe(7500);
    expect(r.applicationDeadline?.getTime()).toBe(DEADLINE.getTime());
    expect(r.ticketUrl).toBe("https://harvestfair.example");
    expect(r.startDate?.getTime()).toBe(START.getTime());
    expect(r.endDate?.getTime()).toBe(END.getTime());
    expect(days()).toHaveLength(1);
  });

  it("fields that ARE sent are still written, including an explicit clear", async () => {
    await save({
      id: "e1",
      venueId: "v1",
      name: "Harvest Fair",
      description: "Original description",
      categories: ["Festival"],
      ticketPriceMin: null,
    });
    const r = row();
    expect(JSON.parse(r.categories as string)).toEqual(["Festival"]);
    expect(r.ticketPriceMinCents).toBeNull();
    expect(r.vendorFeeMinCents).toBe(7500); // not sent → untouched
  });

  it("a sent day set still replaces the stored days", async () => {
    await save({
      id: "e1",
      venueId: "v1",
      name: "Harvest Fair",
      description: "Original description",
      eventDays: [
        { date: "2026-09-12", openTime: "10:00", closeTime: "16:00" },
        { date: "2026-09-13", openTime: "10:00", closeTime: "16:00" },
      ],
    });
    expect(days()).toHaveLength(2);
  });

  it("submit still moves DRAFT → PENDING on a partial save", async () => {
    const res = await save({
      id: "e1",
      venueId: "v1",
      name: "Harvest Fair",
      description: "Original description",
      submit: true,
    });
    expect(res.body.status).toBe("PENDING");
    expect(row().status).toBe("PENDING");
    expect(JSON.parse(row().categories as string)).toEqual(["Craft Fair"]);
  });
});
