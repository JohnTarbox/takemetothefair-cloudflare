/**
 * OPE-1396 (DUP6) — MCP `apply_to_event` runs the app's vendor-joins-event rule
 * (`checkEventAcceptsVendor` / `defaultApplicationStatus`, now in
 * @takemetothefair/utils), not its own copy. The copy accepted TENTATIVE
 * events; the app (session + token routes) accepts APPROVED only.
 *
 * In-memory SQLite + CapturingMcpServer; the row is read back after each call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { eventVendors, events, promoters, users, vendors } from "../src/schema.js";

let db: TestDb;
let server: CapturingMcpServer;

function setup(vendor: { commercial?: boolean; canSelfConfirm?: boolean } = {}) {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
  db.insert(users).values({ id: "u-p", email: "p@test", role: "PROMOTER" }).run();
  db.insert(promoters)
    .values({ id: "p1", userId: "u-p", companyName: "P", slug: "p" as never })
    .run();
  db.insert(vendors)
    .values({
      id: "v1",
      userId: "u-v",
      businessName: "Kettle Co",
      slug: "kettle-co" as never,
      commercial: vendor.commercial ?? false,
      canSelfConfirm: vendor.canSelfConfirm ?? false,
    })
    .run();
  registerVendorTools(server as never, db, {
    userId: "u-v",
    role: "VENDOR",
    vendorId: "v1",
  } as never);
}

function addEvent(slug: string, status: string, commercialVendorsAllowed = true) {
  db.insert(events)
    .values({
      id: slug,
      name: slug,
      slug: slug as never,
      status: status as never,
      commercialVendorsAllowed,
      promoterId: "p1",
    } as never)
    .run();
}

async function apply(slug: string) {
  const r = (await server.invoke("apply_to_event", { event_slug: slug })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, text: r.content[0].text };
}

function linkStatus(eventId: string): string | undefined {
  return db
    .select({ status: eventVendors.status })
    .from(eventVendors)
    .where(and(eq(eventVendors.eventId, eventId), eq(eventVendors.vendorId, "v1")))
    .get()?.status;
}

describe("apply_to_event — shared rule", () => {
  beforeEach(() => setup());

  it("refuses a TENTATIVE event (the app accepts APPROVED only) and writes nothing", async () => {
    addEvent("tentative-fair", "TENTATIVE");
    const r = await apply("tentative-fair");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("This event is not currently accepting vendor applications");
    expect(linkStatus("tentative-fair")).toBeUndefined();
  });

  it("accepts an APPROVED event with the default APPLIED status", async () => {
    addEvent("approved-fair", "APPROVED");
    const r = await apply("approved-fair");
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).status).toBe("APPLIED");
    expect(linkStatus("approved-fair")).toBe("APPLIED");
  });

  it("refuses a commercial vendor where commercial vendors are not allowed", async () => {
    setup({ commercial: true });
    addEvent("no-commercial", "APPROVED", false);
    const r = await apply("no-commercial");
    expect(r.isError).toBe(true);
    expect(linkStatus("no-commercial")).toBeUndefined();
  });

  it("a canSelfConfirm vendor lands CONFIRMED (defaultApplicationStatus)", async () => {
    setup({ canSelfConfirm: true });
    addEvent("approved-fair", "APPROVED");
    await apply("approved-fair");
    expect(linkStatus("approved-fair")).toBe("CONFIRMED");
  });
});
