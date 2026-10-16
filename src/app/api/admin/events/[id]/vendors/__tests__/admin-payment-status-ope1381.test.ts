/**
 * OPE-1381 — after vendors lost the ability to set their own paymentStatus,
 * the admin route must still record it. Pins the positive side of the rule
 * (admin can) and that a non-admin session cannot use this route to do it.
 * Real route, real SQLite; only the session is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let db: unknown;
let role: "ADMIN" | "VENDOR" = "ADMIN";
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u-actor", role, roles: [role] } })),
  hasRole: (s: { user: { roles: string[] } }, r: string) => s.user.roles.includes(r),
}));

import { PATCH } from "../route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const EV_ID = "11111111-1111-4111-8111-111111111111";
let raw: InstanceType<typeof Database>;

function patch(body: unknown) {
  const req = new Request("https://example.com/api/admin/events/e1/vendors", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
  return PATCH(req, { params: Promise.resolve({ id: "e1" }) });
}

const payment = () =>
  (
    raw.prepare("SELECT payment_status p FROM event_vendors WHERE id = ?").get(EV_ID) as {
      p: string;
    }
  ).p;

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [schema.vendors, schema.events, schema.eventVendors, schema.errorLogs]) {
    raw.exec(ddlFor(t));
  }
  raw
    .prepare("INSERT INTO vendors (id, user_id, business_name, slug) VALUES ('v1','u1','V','v')")
    .run();
  raw
    .prepare(
      "INSERT INTO event_vendors (id, event_id, vendor_id, status, payment_status) VALUES (?, 'e1', 'v1', 'CONFIRMED', 'PENDING')"
    )
    .run(EV_ID);
  db = drizzle(raw, { schema });
  role = "ADMIN";
});

describe("PATCH /api/admin/events/[id]/vendors — paymentStatus (OPE-1381)", () => {
  it("an admin can set PAID", async () => {
    const res = await patch({ eventVendorId: EV_ID, paymentStatus: "PAID" });
    expect(res.status).toBe(200);
    expect(payment()).toBe("PAID");
  });

  it("a vendor session cannot use the admin route", async () => {
    role = "VENDOR";
    const res = await patch({ eventVendorId: EV_ID, paymentStatus: "PAID" });
    // withAuth answers a wrong role with 401 (the route's legacy shape).
    expect(res.status).toBe(401);
    expect(payment()).toBe("PENDING");
  });
});
