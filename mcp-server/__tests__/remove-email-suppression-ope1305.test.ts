/**
 * OPE-1305 — `remove_email_suppression`, the way back off the suppression list.
 *
 * A full mailbox (SMTP 552 5.2.2) bounced an auto-ack, `cf-delivery-event`
 * suppressed the sender with reason `bounce`, and John's approved human reply
 * could then never be sent: the reply lane honours the list and nothing could
 * take the address off it.
 *
 * Driven through the registered tool (the CapturingMcpServer harness) against
 * the real table, and the reply lane's own `isEmailSuppressed` read, so
 * "a subsequent reply is attempted" is checked at the gate that would skip it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  registerSendVendorEmailTool,
  isEmailSuppressed,
} from "../src/tools/admin-send-vendor-email.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;

const AUTH = { userId: "u-admin", role: "ADMIN" as const };

function suppress(email: string, reason: string | null, source = "cf-delivery-event") {
  raw["prepare"](
    `INSERT INTO email_suppression_list (email, reason, source, created_at) VALUES (?,?,?,?)`
  ).run(email, reason, source, 1_791_000_000);
}

const auditRows = () =>
  raw["prepare"](
    `SELECT action, actor_user_id, target_type, target_id, payload_json FROM admin_actions`
  ).all() as Array<{
    action: string;
    actor_user_id: string;
    target_type: string;
    target_id: string;
    payload_json: string;
  }>;

const listed = () =>
  (
    raw["prepare"](`SELECT email FROM email_suppression_list`).all() as Array<{ email: string }>
  ).map((r) => r.email);

async function call(args: Record<string, unknown>) {
  const res = (await server.invoke("remove_email_suppression", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { json: JSON.parse(res.content[0].text), isError: !!res.isError };
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerSendVendorEmailTool(server as never, db, AUTH, {} as never);
});

describe("OPE-1305 — remove_email_suppression", () => {
  it("removes a bounce row, returns it, and the reply gate no longer skips the address", async () => {
    suppress("fairgoer@example.com", "bounce");
    expect(await isEmailSuppressed(db, "fairgoer@example.com")).toBe(true);

    // Mixed case on the way in: the list is keyed lowercase.
    const { json, isError } = await call({
      email: "  FairGoer@Example.com ",
      reason: "552 over-quota is temporary; John approved the reply",
    });

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.removed).toMatchObject({
      email: "fairgoer@example.com",
      reason: "bounce",
      source: "cf-delivery-event",
    });
    expect(listed()).toEqual([]);
    expect(await isEmailSuppressed(db, "fairgoer@example.com")).toBe(false);
  });

  it("writes one audit row naming who, what was removed, and the stated reason", async () => {
    suppress("fairgoer@example.com", "bounce");
    await call({ email: "fairgoer@example.com", reason: "temporary bounce" });

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "email.suppression_removed",
      actor_user_id: "u-admin",
      target_type: "email",
      target_id: "fairgoer@example.com",
    });
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.removed.reason).toBe("bounce");
    expect(payload.stated_reason).toBe("temporary bounce");
    expect(payload.override_opt_out).toBe(false);
  });

  for (const optOut of ["unsubscribe", "complaint"]) {
    it(`refuses a '${optOut}' row without the override and changes nothing`, async () => {
      suppress("optedout@example.com", optOut, "unsubscribe-link");
      const { json, isError } = await call({ email: "optedout@example.com", reason: "oops" });

      expect(isError).toBe(true);
      expect(json.error).toBe("opt_out_requires_override");
      expect(listed()).toEqual(["optedout@example.com"]);
      expect(auditRows()).toHaveLength(0);
    });
  }

  it("removes an 'unsubscribe' row WITH the override, and records that the override was used", async () => {
    suppress("cameback@example.com", "unsubscribe", "unsubscribe-link");
    const { json } = await call({
      email: "cameback@example.com",
      reason: "they wrote asking to be re-subscribed",
      override_opt_out: true,
    });

    expect(json.ok).toBe(true);
    expect(listed()).toEqual([]);
    expect(JSON.parse(auditRows()[0].payload_json).override_opt_out).toBe(true);
  });

  it("an address not on the list is a clear not_found, not a silent success", async () => {
    suppress("someone-else@example.com", "bounce");
    const { json, isError } = await call({ email: "nobody@example.com", reason: "x".repeat(5) });

    expect(isError).toBe(true);
    expect(json.error).toBe("not_found");
    expect(listed()).toEqual(["someone-else@example.com"]);
    expect(auditRows()).toHaveLength(0);
  });

  it("removes exactly one row — other suppressions are untouched", async () => {
    suppress("a@example.com", "bounce");
    suppress("b@example.com", "bounce");
    suppress("c@example.com", "manual", "admin");
    await call({ email: "b@example.com", reason: "temporary bounce" });
    expect(listed().sort()).toEqual(["a@example.com", "c@example.com"]);
  });

  it("is not registered for a non-admin", () => {
    const s = new CapturingMcpServer();
    registerSendVendorEmailTool(
      s as never,
      db,
      { userId: "u", role: "VENDOR" } as never,
      {} as never
    );
    expect(() => s.invoke("remove_email_suppression", {})).toThrow();
  });
});
