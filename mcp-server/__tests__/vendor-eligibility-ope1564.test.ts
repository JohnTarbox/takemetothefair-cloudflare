/**
 * OPE-1564 — `events.vendor_eligibility` / `vendor_eligibility_org`, MCP side.
 *
 * Pins: a new event defaults to OPEN; update_event writes both and, with a
 * `citation`, records one event_data_citations row per field (the "tracked
 * field like the vendor fees" acceptance); both readers return what was
 * written; commercial_vendors_allowed is untouched (a separate axis); and an
 * off-enum value is refused before any write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events, promoters, eventDataCitations } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };
const EVENT_ID = "b1564000-0000-4000-8000-000000000001";
const SRC = "https://sites.google.com/view/the-craftworkers-guild/members-and-vendors";
const ORG = "The Craftworkers' Guild";

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  registerAdminEventReadTools(server as never, db, ADMIN_AUTH as never);
  mock = mockIndexNowFetch();
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Craftworkers' Guild Holiday Shop 2026",
      slug: "craftworkers-guild-holiday-shop-2026",
      promoterId: "p-1",
      status: "APPROVED",
      commercialVendorsAllowed: true,
    })
    .run();
});
afterEach(() => mock.restore());

function body(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  let json: Record<string, unknown> | string;
  try {
    json = JSON.parse(r.content[0].text);
  } catch {
    json = r.content[0].text;
  }
  return { isError: !!r.isError, json: json as Record<string, unknown> };
}
const eventRow = () => db.select().from(events).where(eq(events.id, EVENT_ID)).all()[0];
const activeCitations = (field: string) =>
  db
    .select()
    .from(eventDataCitations)
    .where(
      and(
        eq(eventDataCitations.eventId, EVENT_ID),
        eq(eventDataCitations.fieldName, field),
        eq(eventDataCitations.state, "active")
      )
    )
    .all();

describe("vendor eligibility (OPE-1564)", () => {
  it("defaults to OPEN with no org — what every existing row reads as", () => {
    expect(eventRow().vendorEligibility).toBe("OPEN");
    expect(eventRow().vendorEligibilityOrg).toBeNull();
  });

  it("update_event writes MEMBERS_ONLY + org and cites BOTH fields from `citation`", async () => {
    const r = body(
      await server.invoke("update_event", {
        event_id: EVENT_ID,
        vendor_eligibility: "MEMBERS_ONLY",
        vendor_eligibility_org: ORG,
        citation: { source_url: SRC, source_type: "official_website" },
      })
    );
    expect(r.isError).toBe(false);
    expect(eventRow().vendorEligibility).toBe("MEMBERS_ONLY");
    expect(eventRow().vendorEligibilityOrg).toBe(ORG);

    const elig = activeCitations("vendor_eligibility");
    const org = activeCitations("vendor_eligibility_org");
    expect(elig).toHaveLength(1);
    expect(elig[0].value).toBe("MEMBERS_ONLY");
    expect(elig[0].sourceUrl).toBe(SRC);
    expect(org).toHaveLength(1);
    expect(org[0].value).toBe(ORG);
    // OPE-1110 — neither field may be reported as "citation ignored".
    const warnings = (r.json.warnings ?? {}) as Record<string, unknown>;
    expect(warnings.citation_ignored_for ?? []).not.toContain("vendor_eligibility");
    expect(warnings.citation_ignored_for ?? []).not.toContain("vendor_eligibility_org");
  });

  it("is a separate axis: commercial_vendors_allowed is unchanged by an eligibility write", async () => {
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      vendor_eligibility: "JURIED",
    });
    expect(eventRow().vendorEligibility).toBe("JURIED");
    expect(eventRow().commercialVendorsAllowed).toBe(true);
  });

  it("get_event_details_admin returns what the writer wrote", async () => {
    await server.invoke("update_event", {
      event_id: EVENT_ID,
      vendor_eligibility: "MEMBERS_ONLY",
      vendor_eligibility_org: ORG,
    });
    const r = body(await server.invoke("get_event_details_admin", { event_id: EVENT_ID }));
    expect(r.isError).toBe(false);
    const text = JSON.stringify(r.json);
    expect(text).toContain('"vendor_eligibility":"MEMBERS_ONLY"');
    expect(text).toContain(`"vendor_eligibility_org":${JSON.stringify(ORG)}`);
  });

  it("refuses an off-enum value and writes nothing", async () => {
    const r = body(
      await server.invoke("update_event", { event_id: EVENT_ID, vendor_eligibility: "CLOSED" })
    );
    expect(r.isError).toBe(true);
    expect(eventRow().vendorEligibility).toBe("OPEN");
  });

  it("vendor_eligibility_org: null clears it", async () => {
    await server.invoke("update_event", { event_id: EVENT_ID, vendor_eligibility_org: ORG });
    expect(eventRow().vendorEligibilityOrg).toBe(ORG);
    await server.invoke("update_event", { event_id: EVENT_ID, vendor_eligibility_org: null });
    expect(eventRow().vendorEligibilityOrg).toBeNull();
  });
});
