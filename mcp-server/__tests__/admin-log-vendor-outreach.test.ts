/**
 * Tests for the log_vendor_outreach MCP tool (analyst J1, 2026-05-29 PM).
 *
 * Confirms the happy path (insert + audit row), the vendor-not-found
 * error path, and outcome_at timing rules (set when outcome is present,
 * null when outcome is omitted — the "in flight" case).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, vendorOutreachAttempts, vendors, users } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);

  // Seed a vendor + user so the tool has something to write against.
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(users).values({ id: "u-v1", email: "v1@test", role: "VENDOR" }).run();
  db.insert(vendors)
    .values({
      id: "v-1",
      userId: "u-v1",
      businessName: "Test Vendor LLC",
      slug: "test-vendor-llc",
    })
    .run();
});

async function invoke(args: Record<string, unknown>) {
  const result = (await server.invoke("log_vendor_outreach", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: !!result.isError,
    text: result.content[0].text,
    payload: result.isError
      ? null
      : (JSON.parse(result.content[0].text) as {
          success: boolean;
          attempt_id: string;
          vendor_id: string;
          business_name: string;
          channel: string;
          outcome: string | null;
        }),
  };
}

describe("log_vendor_outreach — happy path", () => {
  it("inserts a row with outcome + outcome_at when outcome is provided", async () => {
    const r = await invoke({
      vendor_id: "v-1",
      channel: "email",
      outcome: "sent",
      notes: "Sent intro pitch via gmail",
    });
    expect(r.isError).toBe(false);
    expect(r.payload?.outcome).toBe("sent");
    expect(r.payload?.business_name).toBe("Test Vendor LLC");

    const inserted = db
      .select()
      .from(vendorOutreachAttempts)
      .where(eq(vendorOutreachAttempts.vendorId, "v-1"))
      .all();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].channel).toBe("email");
    expect(inserted[0].outcome).toBe("sent");
    expect(inserted[0].outcomeAt).toBeInstanceOf(Date);
    expect(inserted[0].notes).toBe("Sent intro pitch via gmail");
    expect(inserted[0].createdBy).toBe("u-admin");
  });

  it("leaves outcome + outcome_at null when outcome is omitted (in-flight log)", async () => {
    await invoke({ vendor_id: "v-1", channel: "phone" });
    const inserted = db
      .select()
      .from(vendorOutreachAttempts)
      .where(eq(vendorOutreachAttempts.vendorId, "v-1"))
      .all();
    expect(inserted[0].outcome).toBeNull();
    expect(inserted[0].outcomeAt).toBeNull();
  });

  it("writes an admin_actions audit row tagged via=mcp", async () => {
    await invoke({ vendor_id: "v-1", channel: "in_person", outcome: "claimed" });
    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "vendor.outreach_logged"))
      .all();
    expect(audits).toHaveLength(1);
    const payload = JSON.parse(audits[0].payloadJson ?? "{}") as {
      channel: string;
      outcome: string;
      via: string;
    };
    expect(payload.channel).toBe("in_person");
    expect(payload.outcome).toBe("claimed");
    expect(payload.via).toBe("mcp");
  });
});

describe("log_vendor_outreach — error paths", () => {
  it("returns isError when vendor_id doesn't exist", async () => {
    const r = await invoke({ vendor_id: "v-missing", channel: "email" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Vendor not found");
    const audits = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "vendor.outreach_logged"))
      .all();
    expect(audits).toHaveLength(0);
  });
});
