/**
 * OPE-1381 — the session route (`POST /api/vendor/applications`) used to
 * ignore a `paymentStatus` in the body: silently dropped, never refused. It
 * now asks the same `checkVendorPaymentStatus` as the token route: a vendor
 * that is not canSelfConfirm gets 403 PAYMENT_STATUS_FORBIDDEN and nothing is
 * written; a canSelfConfirm vendor's value is written, not dropped.
 *
 * Real route, real SQLite; only the session gate is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let db: unknown;
let sessionUserId = "u-plain";
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null), hasRole: () => false }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({ ok: true, userId: sessionUserId })),
}));

import { POST } from "../route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;

function post(body: unknown) {
  const req = new Request("https://example.com/api/vendor/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
  return POST(req);
}

const row = (vendorId: string) =>
  raw
    .prepare("SELECT status, payment_status AS p FROM event_vendors WHERE vendor_id = ?")
    .get(vendorId) as { status: string; p: string } | undefined;

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    schema.users,
    schema.vendors,
    schema.events,
    schema.eventVendors,
    schema.errorLogs,
  ]) {
    raw.exec(ddlFor(t));
  }
  raw
    .prepare(
      "INSERT INTO users (id, email, email_verified) VALUES ('u-plain','p@x.com',1780000000), ('u-trusted','t@x.com',1780000000)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug, can_self_confirm, commercial) VALUES ('v-plain','u-plain','Plain','plain',0,0), ('v-trusted','u-trusted','Trusted','trusted',1,0)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, status, commercial_vendors_allowed) VALUES ('e-open','Open','open','APPROVED',1)"
    )
    .run();
  db = drizzle(raw, { schema });
  sessionUserId = "u-plain";
});

describe("POST /api/vendor/applications — paymentStatus (OPE-1381)", () => {
  it("a plain vendor sending PAID is 403 PAYMENT_STATUS_FORBIDDEN and no application is created", async () => {
    const res = await post({ eventId: "e-open", paymentStatus: "PAID" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("PAYMENT_STATUS_FORBIDDEN");
    expect(row("v-plain")).toBeUndefined();
  });

  it("a plain vendor sending the default NOT_REQUIRED is still refused (presence is the refusal)", async () => {
    const res = await post({ eventId: "e-open", paymentStatus: "NOT_REQUIRED" });
    expect(res.status).toBe(403);
    expect(row("v-plain")).toBeUndefined();
  });

  it("a plain vendor without paymentStatus applies normally (APPLIED, NOT_REQUIRED)", async () => {
    const res = await post({ eventId: "e-open" });
    expect(res.status).toBe(201);
    expect(row("v-plain")).toEqual({ status: "APPLIED", p: "NOT_REQUIRED" });
  });

  it("a canSelfConfirm vendor's paymentStatus is written, not dropped", async () => {
    sessionUserId = "u-trusted";
    const res = await post({ eventId: "e-open", paymentStatus: "PAID" });
    expect(res.status).toBe(201);
    expect(row("v-trusted")).toEqual({ status: "CONFIRMED", p: "PAID" });
  });

  it("a bad enum is 400", async () => {
    sessionUserId = "u-trusted";
    const res = await post({ eventId: "e-open", paymentStatus: "FREE" });
    expect(res.status).toBe(400);
    expect(row("v-trusted")).toBeUndefined();
  });
});
