/**
 * OPE-1396 (API4–API6) — a soft-deleted vendor (`vendors.deleted_at` set) has
 * its /vendors/<slug> page answered 301/410 by middleware, so no public API
 * may keep serving it:
 *   API4  GET /api/search                  — the vendors section
 *   API5  GET /api/vendors/<slug>/events   — 410 (the vendor page's answer)
 *   API6  GET /api/events/<slug>/vendors   — the event's vendor roster
 *
 * Real SQLite (better-sqlite3) behind the routes, so each assertion reads what
 * the handler actually returned for a live and a deleted vendor side by side.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let raw: InstanceType<typeof Database>;
let db: unknown;

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 30 * 86_400;
const DELETED_AT = 1_780_000_000;

function addVendor(id: string, name: string, deletedAt: number | null = null) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, role, display_override_permitted, deleted_at)
       VALUES (?, ?, ?, ?, 'INDEPENDENT', 0, ?)`
    )
    .run(id, `u-${id}`, name, id, deletedAt);
}

function link(vendorId: string) {
  raw
    .prepare(
      `INSERT INTO event_vendors (id, event_id, vendor_id, status, payment_status, public_visible)
       VALUES (?, 'e1', ?, 'CONFIRMED', 'NOT_REQUIRED', 1)`
    )
    .run(`ev-${vendorId}`, vendorId);
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    schema.vendors,
    schema.events,
    schema.eventVendors,
    schema.venues,
    schema.blogPosts,
    schema.venueNameVariants,
  ]) {
    raw.exec(ddlFor(t));
  }
  db = drizzle(raw, { schema });

  raw
    .prepare(
      `INSERT INTO venues (id, name, slug, city, state, status) VALUES ('v1', 'Grange', 'grange', 'Town', 'ME', 'ACTIVE')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, lifecycle_status, venue_id, start_date, end_date)
       VALUES ('e1', 'Harvest Fair', 'harvest-fair', 'APPROVED', 'SCHEDULED', 'v1', ?, ?)`
    )
    .run(FUTURE, FUTURE);

  addVendor("live-kettle-corn", "Kettlecorn Live");
  addVendor("gone-kettle-corn", "Kettlecorn Gone", DELETED_AT);
  link("live-kettle-corn");
  link("gone-kettle-corn");
});

describe("API4 — /api/search vendors section", () => {
  it("returns the live vendor and not the soft-deleted one", async () => {
    const { GET } = await import("@/app/api/search/route");
    const res = await GET(new Request("https://x.test/api/search?q=kettlecorn"), {
      params: Promise.resolve({}),
    });
    const body = (await res.json()) as { vendors: Array<{ slug: string }> };
    expect(body.vendors.map((v) => v.slug)).toEqual(["live-kettle-corn"]);
  });
});

describe("API5 — /api/vendors/<slug>/events", () => {
  const call = async (slug: string) => {
    const { GET } = await import("@/app/api/vendors/[slug]/events/route");
    return GET(new Request(`https://x.test/api/vendors/${slug}/events`), {
      params: Promise.resolve({ slug }),
    });
  };

  it("serves a live vendor's events (200)", async () => {
    const res = await call("live-kettle-corn");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ slug: string }> };
    expect(body.events.map((e) => e.slug)).toEqual(["harvest-fair"]);
  });

  it("answers 410 for a soft-deleted vendor, matching its page", async () => {
    const res = await call("gone-kettle-corn");
    expect(res.status).toBe(410);
  });

  it("still answers 404 for a slug that never existed", async () => {
    const res = await call("no-such-vendor");
    expect(res.status).toBe(404);
  });

  it("the SSR loader returns null for the deleted vendor (page → notFound)", async () => {
    const { getVendorEventsData } = await import("@/lib/vendors/vendor-events");
    expect(await getVendorEventsData(db as never, "gone-kettle-corn")).toBeNull();
    expect(await getVendorEventsData(db as never, "live-kettle-corn")).not.toBeNull();
  });
});

describe("API6 — /api/events/<slug>/vendors", () => {
  it("lists the live vendor and omits the soft-deleted one", async () => {
    const { GET } = await import("@/app/api/events/[slug]/vendors/route");
    const res = await GET(new Request("https://x.test/api/events/harvest-fair/vendors"), {
      params: Promise.resolve({ slug: "harvest-fair" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vendors: Array<{ slug: string }> };
    expect(body.vendors.map((v) => v.slug)).toEqual(["live-kettle-corn"]);
  });
});
