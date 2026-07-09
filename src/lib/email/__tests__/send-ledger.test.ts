/**
 * OPE-151 — the main-app direct send path (Resend) must write an
 * email_send_ledger row per attempt (it previously wrote nothing, which is why
 * transactional sends like email-verification were un-auditable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Force sendEmail's getRuntimeEnv onto the process.env fallback so the test
// controls RESEND_API_KEY (in vitest getCloudflareContext returns no runtime env).
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no cf context in test");
  },
}));
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { sendEmail } from "../send";
import { emailSendLedger } from "../../db/schema";

const SCHEMA_SQL = `
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, recipient TEXT,
    source TEXT, provider_message_id TEXT, status TEXT NOT NULL DEFAULT 'sent',
    error TEXT, subject TEXT, inbound_email_id TEXT, provider TEXT
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;
const realFetch = globalThis.fetch;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
});

const ARGS = {
  to: "carol@example.com",
  subject: "Verify your email",
  html: "<p>hi</p>",
  text: "hi",
  source: "registration",
  inboundEmailId: "inb-9",
};

describe("sendEmail ledgering (OPE-151)", () => {
  it("Resend success → a 'sent' ledger row with the provider id", async () => {
    process.env.RESEND_API_KEY = "re_test";
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "re_abc123" }), { status: 200 })
    ) as typeof fetch;

    const res = await sendEmail(db, ARGS);
    expect(res.ok).toBe(true);

    const rows = await db.select().from(emailSendLedger);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].provider).toBe("resend");
    expect(rows[0].providerMessageId).toBe("re_abc123");
    expect(rows[0].recipient).toBe("carol@example.com");
    expect(rows[0].source).toBe("registration");
    expect(rows[0].subject).toBe("Verify your email");
    expect(rows[0].inboundEmailId).toBe("inb-9");
  });

  it("Resend failure → a 'failed' ledger row with the error", async () => {
    process.env.RESEND_API_KEY = "re_test";
    globalThis.fetch = vi.fn(
      async () => new Response("invalid recipient", { status: 422 })
    ) as typeof fetch;

    const res = await sendEmail(db, ARGS);
    expect(res.ok).toBe(false);

    const [row] = await db.select().from(emailSendLedger);
    expect(row.status).toBe("failed");
    expect(row.provider).toBe("resend");
    expect(row.error).toContain("Resend 422");
  });

  it("no RESEND_API_KEY → a 'stubbed' ledger row (visible, not silent)", async () => {
    const res = await sendEmail(db, ARGS);
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(emailSendLedger);
    expect(row.status).toBe("stubbed");
    expect(row.provider).toBe("stub");
  });
});
