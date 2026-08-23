/**
 * OPE-526 — `suggest_event` could not capture vendor-application fields.
 *
 * OPE-198 extended the AI extractor's PROMPT for the vendor-application family
 * and wired the mapping on three paths (url-import, email submit, the web
 * suggest-event form). It was reported as covering every intake path. It did
 * not cover this one — and this one is a structured API, so there is no prompt
 * to extend: the tool simply had no parameters for the fields. An agent that
 * read a booth fee off an organizer's page had no way to send it.
 *
 * That is why prod showed `vendor_submission` as a hard zero on all four
 * fields, and `direct_scrape` as zero on fee and deadline: BOTH labels are
 * produced by this tool. `direct_scrape` is not the scraper path — it is the
 * classifier's fallback for "has a domain, not a known aggregator"
 * (source-classification.ts:204). The scraper bulk-import path had produced
 * zero events since OPE-198 shipped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { events, users } from "../src/schema.js";

const AUTH = { userId: "u-submitter", role: "USER" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});

async function suggest(args: Record<string, unknown>) {
  const r = (await server.invoke("suggest_event", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return r.isError
    ? { isError: true, payload: null, errorText: r.content[0].text }
    : { isError: false, payload: JSON.parse(r.content[0].text), errorText: null };
}

const readEvent = async (id: string) =>
  (await db.select().from(events).where(eq(events.id, id)).limit(1))[0];

describe("suggest_event captures the vendor-application family (OPE-526)", () => {
  it("stores every field the caller supplies", async () => {
    const { isError, payload } = await suggest({
      name: "Kingfield Craft Fair",
      start_date: "2026-09-15",
      vendor_fee_min: 50,
      vendor_fee_max: 75,
      vendor_fee_notes: "$50 for 10x10, $75 for 10x20",
      application_url: "https://kingfieldcraftfair.org/apply",
      application_deadline: "2026-08-01",
      application_instructions: "Email photos to organizer@example.com",
      estimated_attendance: 2400,
    });
    expect(isError).toBe(false);

    const row = await readEvent(payload.event.id);
    expect(row.vendorFeeMinCents).toBe(5000); // dollars → cents
    expect(row.vendorFeeMaxCents).toBe(7500);
    expect(row.vendorFeeNotes).toBe("$50 for 10x10, $75 for 10x20");
    expect(row.applicationUrl).toBe("https://kingfieldcraftfair.org/apply");
    expect(row.applicationInstructions).toBe("Email photos to organizer@example.com");
    expect(row.estimatedAttendance).toBe(2400);
    expect(row.applicationDeadline).not.toBeNull();
  });

  it("the reported prod shape — no vendor args — leaves every field NULL, not zero", async () => {
    // NULL over guessing. A defaulted 0 would read as "this fair charges
    // nothing", which is a claim we were never told.
    const { payload } = await suggest({
      name: "Plain Submission",
      start_date: "2026-09-15",
    });
    const row = await readEvent(payload.event.id);
    expect(row.vendorFeeMinCents).toBeNull();
    expect(row.vendorFeeMaxCents).toBeNull();
    expect(row.vendorFeeNotes).toBeNull();
    expect(row.applicationUrl).toBeNull();
    expect(row.applicationDeadline).toBeNull();
    expect(row.applicationInstructions).toBeNull();
    expect(row.estimatedAttendance).toBeNull();
  });

  it("keeps a genuine zero fee — a free booth is data, not absence", async () => {
    // `?? null` rather than `|| null`. Organizers do advertise free booths,
    // and `|| null` would erase that into "unknown".
    const { payload } = await suggest({
      name: "Free Booth Market",
      start_date: "2026-09-15",
      vendor_fee_min: 0,
    });
    const row = await readEvent(payload.event.id);
    expect(row.vendorFeeMinCents).toBe(0);
  });

  // NOTE: no "rejects malformed input" cases here, deliberately.
  // CapturingMcpServer discards the zod schema (`_schema: unknown`) and calls
  // the handler with raw params, so NO mcp-server tool test in this repo
  // exercises parameter validation. Such a test would assert the harness, not
  // the tool, and would pass or fail for reasons unrelated to the code. The
  // `.url()` and YYYY-MM-DD regex constraints are real but are enforced at the
  // MCP boundary, which this harness does not model.
});

describe("the gate this parameter re-enables (OPE-526)", () => {
  // evaluateGates received a hardcoded `applicationDeadline: null` on this
  // path, so start_equals_deadline — the "vendor deadline mistaken for the
  // event date" check — could never fire here. It cannot fire on a value the
  // caller was never able to supply.
  it("routes to PENDING when the start date equals the application deadline", async () => {
    const { payload } = await suggest({
      name: "Deadline Equals Start Fair",
      start_date: "2026-09-15",
      application_deadline: "2026-09-15",
      source_url: "https://example.org/fair",
    });
    const row = await readEvent(payload.event.id);
    expect(row.status).toBe("PENDING");
    expect(row.gateFlags).toContain("start_equals_deadline");
  });

  it("a different deadline does not trip that gate (control)", async () => {
    const { payload } = await suggest({
      name: "Normal Deadline Fair",
      start_date: "2026-09-15",
      application_deadline: "2026-08-01",
      source_url: "https://example.org/fair2",
    });
    const row = await readEvent(payload.event.id);
    expect(row.gateFlags ?? "").not.toContain("start_equals_deadline");
  });
});
