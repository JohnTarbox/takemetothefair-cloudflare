/**
 * OPE-1124 — `update_event`'s response and the reader agree on money.
 *
 * Live (09-22, event ac556d07): `vendor_fee_max: 20` was written correctly,
 * but the response said `newValues.vendor_fee_max: 2000` (the raw `_cents`
 * column) while `get_event_details_admin` read back 20. Every skill verifies a
 * write from the response (OPE-534), so a correct write read as a $2,000 error.
 *
 * Driven through the REAL tools on a real (sqlite) row: a unit test of the
 * presenter alone would pass even if admin.ts never called it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events, users, promoters } from "../src/schema.js";
import { presentStoredValue } from "../src/helpers.js";

const AUTH = { userId: "u-admin", role: "ADMIN" as const };
const MONEY = ["vendor_fee_min", "vendor_fee_max", "ticket_price_min", "ticket_price_max"] as const;

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(async () => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" as never })
    .run();
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, AUTH, undefined);
  registerAdminEventReadTools(server as never, db, AUTH);
  await db.insert(events).values({
    id: "ev-1",
    name: "Hackmatack Craft Fair",
    slug: "hackmatack-craft-fair" as never,
    promoterId: "p-1",
    status: "APPROVED",
  } as typeof events.$inferInsert);
});

async function call(name: string, args: Record<string, unknown>) {
  const res = (await server.invoke(name, args)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

/** The reader nests some fields; find the key wherever it is. */
function find(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const hit = find(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe("OPE-1124 — money is reported in the unit the caller wrote", () => {
  it("ACCEPTANCE: vendor_fee_max: 20 → the response and the reader both say 20", async () => {
    const res = await call("update_event", { event_id: "ev-1", vendor_fee_max: 20 });
    const read = await call("get_event_details_admin", { event_id: "ev-1" });

    expect(find(res, "newValues")).toMatchObject({ vendor_fee_max: 20 });
    expect(find(read, "vendor_fee_max")).toBe(20);
    // The stored column is still cents — the fix is presentation, not storage.
    const row = db.select().from(events).all()[0] as { vendorFeeMaxCents: number };
    expect(row.vendorFeeMaxCents).toBe(2000);
  });

  it("all four money fields agree with the reader, including a non-round value", async () => {
    const written = {
      vendor_fee_min: 12.5,
      vendor_fee_max: 40,
      ticket_price_min: 5,
      ticket_price_max: 19.99,
    };
    const res = await call("update_event", { event_id: "ev-1", ...written });
    const read = await call("get_event_details_admin", { event_id: "ev-1" });
    const nv = find(res, "newValues") as Record<string, unknown>;

    for (const f of MONEY) {
      expect(nv[f], `newValues.${f}`).toBe(written[f]);
      expect(find(read, f), `reader ${f}`).toBe(written[f]);
    }
  });

  it("previousValues is in dollars too — and a no-op re-write reports no change (OPE-645 kept)", async () => {
    await call("update_event", { event_id: "ev-1", vendor_fee_max: 20 });
    const res = await call("update_event", { event_id: "ev-1", vendor_fee_max: 20 });

    expect(find(res, "previousValues")).toMatchObject({ vendor_fee_max: 20 });
    expect(find(res, "newValues")).toMatchObject({ vendor_fee_max: 20 });
  });
});

describe("presentStoredValue — pinned from both sides", () => {
  it("converts only *Cents numbers", () => {
    expect(presentStoredValue("vendorFeeMaxCents", 2000)).toBe(20);
    expect(presentStoredValue("vendorFeeMaxCents", null)).toBeNull();
    expect(presentStoredValue("estimatedAttendance", 2000)).toBe(2000);
    expect(presentStoredValue(undefined, "Kingfield")).toBe("Kingfield");
  });
});
