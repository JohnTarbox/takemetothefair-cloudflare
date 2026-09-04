/**
 * OPE-795 — the broadcast route resolves recipients for the REQUESTED audience.
 *
 * Driven against real SQLite, not a mock chain, and that choice is the whole
 * point of the file. The defect being fixed is `selectBroadcastRecipients(db,
 * "weekend")` written as a string literal in the route: a hand-built mock whose
 * `where()` returns a fixed array answers "which people came back" identically
 * whether the route asked for 'vendor' or 'weekend', so it would go green with
 * the bug still in. The sibling `newsletter-lists.test.ts` already makes exactly
 * this argument for the primitive; the wiring above it needs the same treatment.
 *
 * The seeded population reproduces the live inequality the ticket measured —
 * 3 vendor subscribers against 39 weekend ones — rather than a token 1-vs-1,
 * because the original defect was legible in production only by noticing that a
 * "vendor" pre-flight resolved 39 addresses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    confirmed_at INTEGER,
    unsubscribed_at INTEGER,
    confirmation_token_hash TEXT,
    confirmation_expires INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL,
    list TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    unsubscribed_at INTEGER,
    UNIQUE (subscriber_id, list)
  );
  CREATE TABLE email_suppression_list (
    email TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER
  );
  CREATE TABLE newsletter_issues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    sent_at INTEGER,
    audience TEXT NOT NULL DEFAULT 'weekend',
    created_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sendEnabled = "false";

const authMock = vi.fn();
const enqueueEmailMock = vi.fn(async (_job?: unknown) => {});

vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
  hasRole: (s: { user?: { role?: string } } | null, r: string) => s?.user?.role === r,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({
    NEWSLETTER_SEND_ENABLED: sendEnabled,
    AUTH_SECRET: "s",
    MAILING_ADDRESS: "18 Main ST, Phillips, ME 04966",
  }),
}));
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: (job: unknown) => enqueueEmailMock(job),
}));

import { POST } from "../route";

const ctx = { params: Promise.resolve({}) };
const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/newsletter/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx
  );

/** The live population, to scale: 3 vendor subscribers and 39 weekend ones. */
const VENDOR_EMAILS = Array.from({ length: 3 }, (_, i) => `vendor${i}@example.com`);
const WEEKEND_EMAILS = Array.from({ length: 39 }, (_, i) => `weekend${i}@example.com`);

function seed(email: string, list: string) {
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed) VALUES (?,?,1,0)`
    )
    .run(email, email);
  raw
    .prepare(
      `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at) VALUES (?,?,?,0)`
    )
    .run(`${email}-${list}`, email, list);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
  enqueueEmailMock.mockClear();
  sendEnabled = "false";
  for (const e of VENDOR_EMAILS) seed(e, "vendor");
  for (const e of WEEKEND_EMAILS) seed(e, "weekend");
});

type PreviewBody = {
  recipient_count: number;
  recipients: string[];
  audience: string;
  issue: { audience: string };
};

describe("POST /api/admin/newsletter/send — audience selector (OPE-795)", () => {
  it("audience:'vendor' resolves exactly the 3 vendor addresses", async () => {
    const res = await call({
      subject: "New This Week",
      content_html: "<p>shows</p>",
      audience: "vendor",
      preview_only: true,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as PreviewBody;
    expect(j.recipient_count).toBe(3);
    expect([...j.recipients].sort()).toEqual([...VENDOR_EMAILS].sort());
    // Not one weekend address leaked in — the acceptance's "the two lists never
    // merge in one send", asserted on the send that actually resolves them.
    expect(j.recipients.some((e) => e.startsWith("weekend"))).toBe(false);
  });

  it("audience:'weekend' resolves exactly the 39 attendee addresses", async () => {
    const res = await call({
      subject: "This Weekend at the Fair",
      content_html: "<p>fairs</p>",
      audience: "weekend",
      preview_only: true,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as PreviewBody;
    expect(j.recipient_count).toBe(39);
    expect(j.recipients.some((e) => e.startsWith("vendor"))).toBe(false);
  });

  it("the preview echoes the audience it resolved, so the pre-flight is a truthful rehearsal", async () => {
    const j = (await (
      await call({
        subject: "New This Week",
        content_html: "<p>x</p>",
        audience: "vendor",
        preview_only: true,
      })
    ).json()) as PreviewBody;
    expect(j.audience).toBe("vendor");
    expect(j.issue.audience).toBe("vendor");
  });

  it("omitting audience is a 400, NOT a silent default to the larger list", async () => {
    const res = await call({
      subject: "New This Week",
      content_html: "<p>x</p>",
      preview_only: true,
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("invalid_audience");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("an unrecognised audience is refused rather than coerced", async () => {
    const res = await call({
      subject: "x",
      content_html: "<p>x</p>",
      audience: "everyone",
      preview_only: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_audience");
  });

  it("a vendor test send stamps newsletter_issues.audience='vendor' and renders the vendor wordmark", async () => {
    const res = await call({
      subject: "New This Week — shows just added (4)",
      content_html: "<p>shows</p>",
      audience: "vendor",
      test_recipient: "john@example.com",
    });
    expect(res.status).toBe(200);

    const row = raw.prepare(`SELECT audience, sent_at FROM newsletter_issues LIMIT 1`).get() as {
      audience: string;
      sent_at: number | null;
    };
    expect(row.audience).toBe("vendor");
    expect(row.sent_at).toBeNull(); // a test send never joins the public archive

    // OPE-711 §2 on the manual path: the footer must not tell a vendor they
    // subscribed to the attendee newsletter.
    const html = (enqueueEmailMock.mock.calls[0]?.[0] as { html: string }).html;
    expect(html).toContain("New This Week");
    expect(html).not.toContain("This Weekend at the Fair");
  });

  it("re-composing an issue under a different audience updates the stored audience", async () => {
    // The upsert's UPDATE branch. If `audience` were set only on INSERT, the
    // approve route — which reads this column to pick recipients — would target
    // the first audience the slug was ever written with.
    const body = (audience: string) => ({
      subject: "Same Subject",
      content_html: "<p>x</p>",
      audience,
      test_recipient: "john@example.com",
    });
    await call(body("weekend"));
    await call(body("vendor"));
    const rows = raw.prepare(`SELECT audience FROM newsletter_issues`).all() as {
      audience: string;
    }[];
    expect(rows).toHaveLength(1); // same slug → one row
    expect(rows[0].audience).toBe("vendor");
  });
});
