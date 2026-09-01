/**
 * OPE-716 ask 3 — the public/admin asymmetry, made observable and stated.
 *
 * The fix in #1149 taught `list_event_vendors` to honour `public_visible`. That
 * left the ticket's third ask open, and it is not cosmetic: the admin reader was
 * not returning `public_visible` EITHER. So after the fix, a suppressed link was
 * invisible on the public tool (correctly) and indistinguishable from a visible
 * one on the admin tool (incorrectly) — an operator asking "why isn't LeafFilter
 * showing?" had no surface that would tell them.
 *
 * That is why the flag went unnoticed through OPE-316 and this ticket: one
 * reader dropped it from its WHERE and the other from its SELECT, so nothing
 * filtered on it and nothing displayed it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerPublicTools } from "../src/tools/public.js";
import { events, eventVendors, promoters, users, vendors } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "e-marshfield";

let db: TestDb;
let server: CapturingMcpServer;

function textOf(res: unknown): string {
  const r = res as { content?: Array<{ text?: string }> };
  return r.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

beforeEach(async () => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerPublicTools(server as never, db, null as never, ENV as never);

  await db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" });
  await db.insert(promoters).values({
    id: "p-1",
    userId: "u-admin",
    companyName: "Marshfield Agricultural Society",
    slug: "mas",
  });
  await db.insert(events).values({
    id: EVENT_ID,
    promoterId: "p-1",
    name: "Marshfield Fair 2026",
    slug: "marshfield-fair-2026",
    startDate: new Date("2026-08-20T12:00:00Z"),
    endDate: new Date("2026-08-25T12:00:00Z"),
    status: "APPROVED",
  });

  for (const [id, name, visible] of [
    ["v-leaf", "LeafFilter", false],
    ["v-pie", "Pie Stand", true],
  ] as const) {
    await db.insert(users).values({ id: `u-${id}`, email: `${id}@test`, role: "VENDOR" });
    await db
      .insert(vendors)
      .values({ id, userId: `u-${id}`, businessName: name, slug: id, status: "ACTIVE" });
    await db.insert(eventVendors).values({
      id: `ev-${id}`,
      eventId: EVENT_ID,
      vendorId: id,
      status: "APPROVED",
      publicVisible: visible,
    });
  }
});

describe("a suppressed link is hidden from the public reader and VISIBLE to the admin one", () => {
  it("the public tool omits the suppressed vendor", async () => {
    const out = textOf(await server.invoke("list_event_vendors", { event_id: EVENT_ID }));
    expect(out).not.toContain("LeafFilter");
    expect(out).toContain("Pie Stand");
  });

  it("the admin tool still returns it — that asymmetry is the point of an admin view", async () => {
    const out = textOf(await server.invoke("list_event_vendors_admin", { event_id: EVENT_ID }));
    expect(out).toContain("LeafFilter");
    expect(out).toContain("Pie Stand");
  });

  it("the admin tool says WHICH links the public cannot see", async () => {
    // The half of the defect the first PR left open. Returning the row without
    // the flag makes the suppressed link indistinguishable from a visible one on
    // the only surface that still shows it — so the operator can observe the
    // symptom and never the cause.
    const out = textOf(await server.invoke("list_event_vendors_admin", { event_id: EVENT_ID }));
    expect(out).toContain("public_visible");
    const parsed = JSON.parse(out) as { vendors?: Array<Record<string, unknown>> };
    const rows = parsed.vendors ?? [];
    const leaf = rows.find(
      (r) => (r.vendor as { businessName?: string })?.businessName === "LeafFilter"
    );
    const pie = rows.find(
      (r) => (r.vendor as { businessName?: string })?.businessName === "Pie Stand"
    );
    expect(leaf?.public_visible).toBe(false);
    expect(pie?.public_visible).toBe(true);
  });
});

describe("the asymmetry is stated where a caller will read it", () => {
  it("the admin description declares that it returns suppressed links", () => {
    const d = server.descriptions.get("list_event_vendors_admin") ?? "";
    expect(d).toContain("public_visible");
    expect(d.toLowerCase()).toContain("asymmetry");
  });

  it("the public description declares that it excludes them, and points at the admin tool", () => {
    const d = server.descriptions.get("list_event_vendors") ?? "";
    expect(d).toContain("public_visible");
    expect(d).toContain("list_event_vendors_admin");
  });
});
