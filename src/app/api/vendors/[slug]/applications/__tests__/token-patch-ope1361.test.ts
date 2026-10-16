/**
 * OPE-1361 — end to end through the real token route: Bearer token →
 * authenticateVendorToken → withApiToken → PATCH → applyVendorTokenPatch, on
 * real SQLite. Pins that the route is WIRED to the shared rule (a lib test
 * alone would stay green if the route went back to inserting directly).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createHash } from "node:crypto";
import * as schema from "@/lib/db/schema";

let db: unknown;
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null), hasRole: () => false }));

import { PATCH } from "../route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
const TOKEN = "mmatf_plainvendortoken";

function patch(slug: string, body: unknown, token = TOKEN) {
  const req = new Request(`https://example.com/api/vendors/${slug}/applications`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
  return PATCH(req, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    schema.users,
    schema.vendors,
    schema.events,
    schema.eventVendors,
    schema.apiTokens,
    schema.errorLogs,
  ]) {
    raw.exec(ddlFor(t));
  }
  raw
    .prepare("INSERT INTO users (id, email, email_verified) VALUES ('u1','v@x.com',1780000000)")
    .run();
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug, can_self_confirm, commercial) VALUES ('v1','u1','Plain','plain',0,0)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, status, commercial_vendors_allowed) VALUES ('e-open','Open','open','APPROVED',1), ('e-draft','Draft','draft','DRAFT',1)"
    )
    .run();
  raw
    .prepare("INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES ('t1','u1',?,'T')")
    .run(createHash("sha256").update(TOKEN).digest("hex"));
  db = drizzle(raw, { schema });
});

const linkStatus = (eventId: string) =>
  (
    raw
      .prepare("SELECT status FROM event_vendors WHERE vendor_id='v1' AND event_id=?")
      .get(eventId) as { status: string } | undefined
  )?.status;

describe("PATCH /api/vendors/[slug]/applications (OPE-1361)", () => {
  it("a non-canSelfConfirm vendor with no status creates APPLIED, not CONFIRMED", async () => {
    const res = await patch("plain", { eventId: "e-open" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("APPLIED");
    expect(linkStatus("e-open")).toBe("APPLIED");
  });

  it("an explicit CONFIRMED from a non-canSelfConfirm vendor is 403 and writes nothing", async () => {
    const res = await patch("plain", { eventId: "e-open", status: "CONFIRMED" });
    expect(res.status).toBe(403);
    expect(linkStatus("e-open")).toBeUndefined();
  });

  it("a non-public (DRAFT) event is refused", async () => {
    const res = await patch("plain", { eventId: "e-draft" });
    expect(res.status).toBe(400);
    expect(linkStatus("e-draft")).toBeUndefined();
  });

  it("a bad paymentStatus is refused", async () => {
    const res = await patch("plain", { eventId: "e-open", paymentStatus: "WHATEVER" });
    expect(res.status).toBe(400);
    expect(linkStatus("e-open")).toBeUndefined();
  });

  it("OPE-1381: a plain vendor sending paymentStatus PAID is 403 PAYMENT_STATUS_FORBIDDEN, nothing written", async () => {
    const res = await patch("plain", { eventId: "e-open", paymentStatus: "PAID" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("PAYMENT_STATUS_FORBIDDEN");
    expect(linkStatus("e-open")).toBeUndefined();
  });

  it("OPE-1381: a plain vendor cannot flip an existing row to PAID", async () => {
    raw
      .prepare(
        "INSERT INTO event_vendors (id, event_id, vendor_id, status, payment_status) VALUES ('ev1','e-open','v1','APPLIED','NOT_REQUIRED')"
      )
      .run();
    const res = await patch("plain", { eventId: "e-open", paymentStatus: "PAID" });
    expect(res.status).toBe(403);
    expect(
      (
        raw.prepare("SELECT payment_status p FROM event_vendors WHERE id='ev1'").get() as {
          p: string;
        }
      ).p
    ).toBe("NOT_REQUIRED");
  });

  it("OPE-1381: the Cardworks tracker payload (canSelfConfirm vendor) still lands CONFIRMED + PAID", async () => {
    const TRUSTED = "mmatf_trustedvendortoken";
    raw
      .prepare("INSERT INTO users (id, email, email_verified) VALUES ('u2','t@x.com',1780000000)")
      .run();
    raw
      .prepare(
        "INSERT INTO vendors (id, user_id, business_name, slug, can_self_confirm, commercial) VALUES ('v2','u2','Trusted','trusted',1,0)"
      )
      .run();
    raw
      .prepare("INSERT INTO api_tokens (id, user_id, token_hash, name) VALUES ('t2','u2',?,'T')")
      .run(createHash("sha256").update(TRUSTED).digest("hex"));
    // Exact body shape of apps/shows/src/lib/mmf-push.ts (PARTICIPATING).
    const res = await patch(
      "trusted",
      { eventId: "e-open", status: "CONFIRMED", paymentStatus: "PAID" },
      TRUSTED
    );
    expect(res.status).toBe(201);
    expect(
      raw.prepare("SELECT status, payment_status p FROM event_vendors WHERE vendor_id='v2'").get()
    ).toEqual({ status: "CONFIRMED", p: "PAID" });
  });

  it("a revoked token is 401", async () => {
    raw.prepare("UPDATE api_tokens SET revoked_at = 1").run();
    const res = await patch("plain", { eventId: "e-open" });
    expect(res.status).toBe(401);
    expect(linkStatus("e-open")).toBeUndefined();
  });
});
