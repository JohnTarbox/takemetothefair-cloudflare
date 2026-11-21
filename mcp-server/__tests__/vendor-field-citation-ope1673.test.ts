/**
 * OPE-1673 — a vendor fee or application deadline is never stored without the
 * source that states it.
 *
 * Measured 2026-11-17: five events created since 11-10 carried a vendor fee or
 * deadline with no active `event_data_citations` row behind it. Discovery cited
 * the dates on the same events but not the fees, because neither writer asked.
 *
 * Driven through the REAL tools on a real (sqlite) row, and pinned from both
 * sides: each "refused / dropped" case has a "cited → stored" case beside it,
 * so a guard that never fires cannot pass.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { eventDataCitations, events, promoters, users } from "../src/schema.js";

const SOURCE = "https://example.org/craft-fair/vendors";
const EXCERPT = "Booth space is $40 (10x10). Applications are due November 1.";

let db: TestDb;
let server: CapturingMcpServer;

async function invoke(name: string, args: Record<string, unknown>) {
  const r = (await server.invoke(name, args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, text: r.content[0].text };
}

const citationsFor = (eventId: string) =>
  db.select().from(eventDataCitations).where(eq(eventDataCitations.eventId, eventId)).all();

describe("suggest_event (intake): uncited vendor values are DROPPED and named; the event still lands", () => {
  beforeEach(() => {
    ({ db } = createTestDb());
    server = new CapturingMcpServer();
    db.insert(users).values({ id: "u-submitter", email: "s@test", role: "USER" }).run();
    registerVendorTools(server as never, db, { userId: "u-submitter", role: "USER" }, undefined);
  });

  const base = {
    name: "St Michael Holly Fair",
    start_date: "2026-12-05",
    vendor_fee_min: 40,
    application_deadline: "2026-11-01",
    application_url: "https://example.org/craft-fair/apply",
  };

  it("no vendor_citation → fee and deadline NULL, warned, no citation rows", async () => {
    const r = await invoke("suggest_event", base);
    expect(r.isError).toBe(false);
    const payload = JSON.parse(r.text);
    expect(payload.warnings.vendor_fields_dropped_uncited).toEqual([
      "vendor_fee_min",
      "application_deadline",
    ]);
    expect(payload.warnings.vendor_fields_dropped_message).toContain("no vendor_citation");
    const [row] = db.select().from(events).where(eq(events.id, payload.event.id)).all();
    expect(row.vendorFeeMinCents).toBeNull();
    expect(row.applicationDeadline).toBeNull();
    // Landmark: the event and its uncovered fields were written — only the
    // three cited fields were held back.
    expect(row.applicationUrl).toBe(base.application_url);
    expect(citationsFor(payload.event.id)).toHaveLength(0);
  });

  it("an empty excerpt is not a citation", async () => {
    const r = await invoke("suggest_event", {
      ...base,
      vendor_citation: { source_url: SOURCE, source_type: "official_website", excerpt: "   " },
    });
    const payload = JSON.parse(r.text);
    expect(payload.warnings.vendor_fields_dropped_message).toContain("excerpt was empty");
    const [row] = db.select().from(events).where(eq(events.id, payload.event.id)).all();
    expect(row.vendorFeeMinCents).toBeNull();
  });

  it("ACCEPTANCE: with vendor_citation → values stored, one active citation per field", async () => {
    const r = await invoke("suggest_event", {
      ...base,
      vendor_citation: { source_url: SOURCE, source_type: "official_website", excerpt: EXCERPT },
    });
    expect(r.isError).toBe(false);
    const payload = JSON.parse(r.text);
    expect(payload.warnings?.vendor_fields_dropped_uncited).toBeUndefined();
    const [row] = db.select().from(events).where(eq(events.id, payload.event.id)).all();
    expect(row.vendorFeeMinCents).toBe(4000);
    expect(row.applicationDeadline).not.toBeNull();

    const rows = citationsFor(payload.event.id);
    expect(rows.map((c) => c.fieldName).sort()).toEqual(["application_deadline", "vendor_fee_min"]);
    for (const c of rows) {
      expect(c).toMatchObject({ sourceUrl: SOURCE, notes: EXCERPT, state: "active" });
    }
    expect(rows.find((c) => c.fieldName === "vendor_fee_min")?.value).toBe("40");
    expect(rows.find((c) => c.fieldName === "application_deadline")?.value).toBe("2026-11-01");
    expect(payload.citationsInserted).toHaveLength(2);
  });

  it("control: no vendor fields → no warning and no citations", async () => {
    const r = await invoke("suggest_event", { name: "Plain Fair", start_date: "2026-12-05" });
    const payload = JSON.parse(r.text);
    expect(payload.warnings?.vendor_fields_dropped_uncited).toBeUndefined();
    expect(citationsFor(payload.event.id)).toHaveLength(0);
  });
});

describe("update_event (deliberate edit): an uncited vendor value REFUSES the call before any write", () => {
  const EVENT_ID = "ev-holly";

  beforeEach(() => {
    ({ db } = createTestDb());
    server = new CapturingMcpServer();
    db.insert(users).values({ id: "u-admin", email: "a@test", role: "ADMIN" }).run();
    db.insert(promoters)
      .values({ id: "p-1", companyName: "P", slug: "p" as never })
      .run();
    db.insert(events)
      .values({
        id: EVENT_ID,
        name: "St Michael Holly Fair 2026",
        slug: "st-michael-holly-fair-2026" as never,
        promoterId: "p-1",
        status: "APPROVED",
        description: "before",
      } as typeof events.$inferInsert)
      .run();
    registerAdminTools(server as never, db, { userId: "u-admin", role: "ADMIN" }, undefined);
  });

  const readRow = () => db.select().from(events).where(eq(events.id, EVENT_ID)).all()[0];

  it("fee without a citation → refused, and nothing in the call is applied", async () => {
    const r = await invoke("update_event", {
      event_id: EVENT_ID,
      vendor_fee_min: 40,
      description: "after",
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error).toBe("vendor_field_citation_required");
    const row = readRow();
    expect(row.vendorFeeMinCents).toBeNull();
    expect(row.description).toBe("before");
  });

  it("deadline with a citation but no wording in notes → refused", async () => {
    const r = await invoke("update_event", {
      event_id: EVENT_ID,
      application_deadline: "2026-11-01",
      citation: { source_url: SOURCE, source_type: "official_website" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).message).toContain("citation.notes");
    expect(readRow().applicationDeadline).toBeNull();
  });

  it("ACCEPTANCE: with citation + notes → stored, and each field gets its citation row", async () => {
    const r = await invoke("update_event", {
      event_id: EVENT_ID,
      vendor_fee_min: 40,
      vendor_fee_max: 60,
      application_deadline: "2026-11-01",
      citation: { source_url: SOURCE, source_type: "official_website", notes: EXCERPT },
    });
    expect(r.isError).toBe(false);
    const row = readRow();
    expect(row.vendorFeeMinCents).toBe(4000);
    expect(row.vendorFeeMaxCents).toBe(6000);
    expect(row.applicationDeadline).not.toBeNull();
    const fields = db
      .select({ f: eventDataCitations.fieldName })
      .from(eventDataCitations)
      .where(and(eq(eventDataCitations.eventId, EVENT_ID), eq(eventDataCitations.state, "active")))
      .all()
      .map((x) => x.f)
      .sort();
    expect(fields).toEqual(["application_deadline", "vendor_fee_max", "vendor_fee_min"]);
  });

  it("control: an edit that sets no vendor field needs no citation", async () => {
    const r = await invoke("update_event", { event_id: EVENT_ID, description: "after" });
    expect(r.isError).toBe(false);
    expect(readRow().description).toBe("after");
  });
});
