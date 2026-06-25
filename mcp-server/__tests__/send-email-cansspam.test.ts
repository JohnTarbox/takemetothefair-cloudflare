/**
 * Bundle C (2026-06-25) — K41 free-form send + K36 CAN-SPAM footer/suppression.
 *
 * Invokes send_vendor_email + send_test_email against an in-memory SQLite with
 * a capturing EMAIL_JOBS mock, asserting:
 *   - free-form subject/body renders instead of a template (K41)
 *   - every send carries the unsubscribe footer + working /unsubscribe link (K36)
 *   - a suppressed recipient sends NOTHING and writes no rows (K36)
 *   - the test variant stays side-effect-free
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  registerSendVendorEmailTool,
  isEmailSuppressed,
} from "../src/tools/admin-send-vendor-email.js";
import { registerSendTestEmailTool } from "../src/tools/admin-send-test-email.js";
import { vendors, emailSuppressionList, vendorOutreachAttempts } from "../src/schema.js";
import {
  base64UrlEncode,
  computeUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@takemetothefair/utils";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let server: CapturingMcpServer;
let sent: Array<Record<string, unknown>>;
let env: Record<string, unknown>;

function seedVendor(over: Partial<typeof vendors.$inferInsert> = {}) {
  const id = over.id ?? "v-1";
  db.insert(vendors)
    .values({
      id,
      userId: over.userId ?? `user-${id}`,
      businessName: over.businessName ?? "Acme Crafts",
      slug: over.slug ?? "acme-crafts",
      contactEmail: over.contactEmail ?? "owner@acme.test",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

async function invoke(name: string, params: Record<string, unknown>) {
  const res = (await server.invoke(name, params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { res, json: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  sent = [];
  env = {
    EMAIL_JOBS: { send: async (m: Record<string, unknown>) => void sent.push(m) },
    INTERNAL_API_KEY: "test-secret",
    MAIN_APP_URL: "https://meetmeatthefair.com",
  };
  registerSendVendorEmailTool(server as never, db, ADMIN_AUTH, env as never);
  registerSendTestEmailTool(server as never, db, ADMIN_AUTH, env as never);
});

describe("send_vendor_email — K41 free-form + K36 footer", () => {
  it("template send appends a working unsubscribe footer to text and html", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    const { json } = await invoke("send_vendor_email", {
      vendor_id: "v-1",
      template_id: "claim_invite",
    });
    expect(json.success).toBe(true);
    expect(json.mode).toBe("claim_invite");
    // primary + bcc.
    expect(sent).toHaveLength(2);
    const primary = sent[0] as { to: string; text: string; html: string };
    expect(primary.to).toBe("owner@acme.test");
    expect(primary.text).toContain("Unsubscribe:");
    expect(primary.html).toContain("Unsubscribe</a>");

    // The link carries the correct HMAC token for this recipient, in PATH form
    // (no `=`, so quoted-printable transport can't corrupt the hex token).
    const token = await computeUnsubscribeToken("test-secret", "owner@acme.test");
    expect(primary.text).toContain(`/unsubscribe/${base64UrlEncode("owner@acme.test")}/${token}`);
    expect(primary.text).not.toContain("&t="); // the corruption-prone form is gone
  });

  it("free-form subject + body renders instead of a template", async () => {
    seedVendor({ contactEmail: "owner@acme.test" });
    const { json } = await invoke("send_vendor_email", {
      vendor_id: "v-1",
      subject: "Quick question about your booth",
      body: "Hi there — are you returning to the Fryeburg Fair this year?",
    });
    expect(json.mode).toBe("free-form");
    const primary = sent[0] as { subject: string; text: string };
    expect(primary.subject).toBe("Quick question about your booth");
    expect(primary.text).toContain("are you returning to the Fryeburg Fair");
    expect(primary.text).toContain("Unsubscribe:"); // footer still applied
  });

  it("suppressed recipient: sends nothing and writes no outreach row", async () => {
    seedVendor({ contactEmail: "gone@acme.test" });
    db.insert(emailSuppressionList)
      .values({
        email: "gone@acme.test",
        reason: "unsubscribe",
        source: "test",
        createdAt: new Date(),
      })
      .run();

    const { json } = await invoke("send_vendor_email", {
      vendor_id: "v-1",
      template_id: "claim_invite",
    });
    expect(json.success).toBe(false);
    expect(json.suppressed).toBe(true);
    expect(sent).toHaveLength(0);
    const attempts = db.select().from(vendorOutreachAttempts).all();
    expect(attempts).toHaveLength(0);
  });

  it("errors when neither template_id nor subject+body is provided", async () => {
    seedVendor();
    const res = (await server.invoke("send_vendor_email", { vendor_id: "v-1" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("template_id");
    expect(sent).toHaveLength(0);
  });
});

describe("send_test_email — side-effect-free + K36", () => {
  it("free-form test send is [TEST]-prefixed, footered, and writes no vendor rows", async () => {
    const { json } = await invoke("send_test_email", {
      to_address: "me@inbox.test",
      subject: "Deliverability check",
      body: "Plain body.",
    });
    expect(json.success).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as { subject: string; text: string };
    expect(msg.subject.startsWith("[TEST] ")).toBe(true);
    expect(msg.text).toContain("Unsubscribe:");
    // No outreach side effects.
    expect(db.select().from(vendorOutreachAttempts).all()).toHaveLength(0);
  });

  it("honors the suppression list", async () => {
    db.insert(emailSuppressionList)
      .values({
        email: "me@inbox.test",
        reason: "unsubscribe",
        source: "test",
        createdAt: new Date(),
      })
      .run();
    const { json } = await invoke("send_test_email", {
      to_address: "me@inbox.test",
      template_id: "claim_invite",
    });
    expect(json.suppressed).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("unsubscribe token (shared HMAC)", () => {
  it("verifies a matching token and rejects a tampered one / wrong email", async () => {
    const t = await computeUnsubscribeToken("secret", "owner@acme.test");
    expect(await verifyUnsubscribeToken("secret", "owner@acme.test", t)).toBe(true);
    // case-insensitive on the email
    expect(await verifyUnsubscribeToken("secret", "Owner@Acme.test", t)).toBe(true);
    // tampered token
    expect(await verifyUnsubscribeToken("secret", "owner@acme.test", t.slice(0, -1) + "0")).toBe(
      false
    );
    // different recipient
    expect(await verifyUnsubscribeToken("secret", "someone@else.test", t)).toBe(false);
    // wrong secret
    expect(await verifyUnsubscribeToken("other-secret", "owner@acme.test", t)).toBe(false);
  });

  it("base64url round-trips the email and emits no '=' (QP-safe)", async () => {
    for (const e of ["owner@acme.test", "a.b+tag@sub.example.co.uk", "ab@x.io"]) {
      const enc = base64UrlEncode(e);
      expect(enc).not.toMatch(/[=+/]/); // url-safe, unpadded
      const { base64UrlDecode } = await import("@takemetothefair/utils");
      expect(base64UrlDecode(enc)).toBe(e);
    }
  });
});

describe("isEmailSuppressed", () => {
  it("is case-insensitive on the stored lowercase key", async () => {
    db.insert(emailSuppressionList)
      .values({ email: "x@y.test", reason: "manual", source: "test", createdAt: new Date() })
      .run();
    expect(await isEmailSuppressed(db, "X@Y.test")).toBe(true);
    expect(await isEmailSuppressed(db, "other@y.test")).toBe(false);
  });
});
