/**
 * OPE-595 — a free-form send must not require publishing someone's address.
 *
 * `send_vendor_email` is the only on-the-record free-form send: real transport,
 * operator BCC, CAN-SPAM footer, suppression check, and rows in `admin_actions`
 * + `vendor_outreach_attempts`. Its recipient was hardwired to
 * `vendors.contact_email` and it refused a vendor without one.
 *
 * That is a hard block in exactly the case where it matters. `contact_email`
 * RENDERS PUBLICLY as a mailto link on `/vendors/<slug>` and a write to it
 * triggers an IndexNow recrawl, and it is NULL on ~90% of listings (664 of
 * 6,561 populated). So sending one recovery note to a real vendor meant first
 * publishing their personal gmail to the open web.
 *
 * Every workaround is worse: `send_test_email` force-prefixes `[TEST]` and
 * deliberately writes no ledger; `send_promoter_email` is promoter-only;
 * `reply_to_inbound_email` needs an inbound message; hand-sending loses the
 * ledger entirely.
 *
 * Seeded with a REAL NULL `contact_email`, per the acceptance — not mocked
 * around it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerSendVendorEmailTool } from "../src/tools/admin-send-vendor-email.js";
import { adminActions, vendorOutreachAttempts } from "../src/schema.js";

interface SentMail {
  to: string;
  subject: string;
  text: string;
  source: string;
}

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;
let sent: SentMail[];

const AUTH = { userId: "u-admin", role: "ADMIN" as const };

beforeEach(() => {
  ({ db, raw } = createTestDb());
  sent = [];
  const env = {
    // The CAN-SPAM footer HMACs an unsubscribe token; an empty key throws
    // "Zero-length key is not supported" before the send is reached.
    UNSUBSCRIBE_SECRET: "test-unsubscribe-secret",
    MAILING_ADDRESS: "1 Test Way, Portland ME",
    EMAIL_JOBS: {
      send: async (m: SentMail) => {
        sent.push(m);
      },
    },
  };
  server = new CapturingMcpServer();
  registerSendVendorEmailTool(server as never, db, AUTH, env as never);

  raw["prepare"](
    `INSERT INTO users (id, email, name, role) VALUES ('u-owner','21streetbeads@gmail.com','Owner','VENDOR')`
  ).run();
  raw["prepare"](
    `INSERT INTO users (id, email, name, role) VALUES ('u-other','stranger@example.com','Stranger','VENDOR')`
  ).run();
  // The real shape: a claimed listing whose contact_email is NULL.
  raw["prepare"](
    `INSERT INTO vendors (id, business_name, slug, contact_email, claimed, claimed_by, user_id)
     VALUES ('v-1','21 Street Beads','21-street-beads',NULL,1,'u-owner','u-owner')`
  ).run();
  // A listing with nobody attached at all.
  // A listing whose owner/claimant links are both empty strings — the shape a
  // vendor created by ingest has, with nobody attached.
  raw["prepare"](
    `INSERT INTO vendors (id, business_name, slug, contact_email, claimed, user_id, claimed_by)
     VALUES ('v-orphan','Orphan Crafts','orphan-crafts',NULL,0,'','')`
  ).run();
});

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
const send = (args: Record<string, unknown>) =>
  server.invoke("send_vendor_email", { subject: "Hello", body: "Body text", ...args });

describe("OPE-595 — recipient override", () => {
  it("sends to a vendor whose contact_email is NULL when the owner's address is supplied", async () => {
    const out = parse(await send({ vendor_id: "v-1", email: "21streetbeads@gmail.com" }));
    expect(out.success).toBe(true);
    expect(out.sent_to).toBe("21streetbeads@gmail.com");
    // Primary + operator BCC.
    expect(sent.map((m) => m.to)).toContain("21streetbeads@gmail.com");
    expect(sent.find((m) => m.source === "email:vendor-outreach")).toBeTruthy();
  });

  it("still refuses that same vendor with no override — unchanged behaviour", async () => {
    const res = (await send({ vendor_id: "v-1" })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("refuses an address that owns nothing — this is not a send-to-anyone tool", async () => {
    const res = (await send({ vendor_id: "v-1", email: "stranger@example.com" })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("refuses when the vendor has no owner and no claimant, and says why", async () => {
    const res = (await send({ vendor_id: "v-orphan", email: "21streetbeads@gmail.com" })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(parse(res).note).toContain("no owner and no claimant");
    expect(sent).toHaveLength(0);
  });

  it("matches the owner case-insensitively, as the parameter promises", async () => {
    const out = parse(await send({ vendor_id: "v-1", email: "21StreetBeads@Gmail.com" }));
    expect(out.success).toBe(true);
    expect(out.sent_to).toBe("21streetbeads@gmail.com");
  });

  it("honours suppression on the OVERRIDE address, not just contact_email", async () => {
    // The gate has to follow the recipient. Checking the vendor's (NULL)
    // contact_email would let a suppressed override through silently.
    raw["prepare"](
      `INSERT INTO email_suppression_list (email, reason, created_at) VALUES ('21streetbeads@gmail.com','unsubscribed',unixepoch())`
    ).run();
    const out = parse(await send({ vendor_id: "v-1", email: "21streetbeads@gmail.com" }));
    expect(out.suppressed).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("records the override in the audit row, so the ledger says where it went", async () => {
    await send({ vendor_id: "v-1", email: "21streetbeads@gmail.com" });
    const [action] = await db.select().from(adminActions);
    const payload = JSON.parse(action.payloadJson ?? "{}");
    // Without this the audit row names the vendor and not the human.
    expect(payload.to).toBe("21streetbeads@gmail.com");
    expect(payload.recipient_override).toBe("21streetbeads@gmail.com");
    const [attempt] = await db.select().from(vendorOutreachAttempts);
    expect(attempt.notes).toContain("override");
  });

  it("writes no audit or outreach row when suppressed", async () => {
    raw["prepare"](
      `INSERT INTO email_suppression_list (email, reason, created_at) VALUES ('21streetbeads@gmail.com','unsubscribed',unixepoch())`
    ).run();
    await send({ vendor_id: "v-1", email: "21streetbeads@gmail.com" });
    expect(await db.select().from(adminActions)).toHaveLength(0);
    expect(await db.select().from(vendorOutreachAttempts)).toHaveLength(0);
  });
});
