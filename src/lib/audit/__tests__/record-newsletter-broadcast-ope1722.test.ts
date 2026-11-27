/**
 * OPE-1722 — a newsletter BROADCAST leaves exactly one `admin_actions` row
 * naming who sent it, on both broadcast paths; a test send leaves none; and an
 * audit insert that throws changes nothing about the send.
 *
 * The specimen: the Nov 27 weekend issue went to 121 recipients at 19:00:53Z
 * and nothing recorded who triggered it.
 *
 * Real SQLite (not a mock chain): the claim under test is "a row lands in
 * admin_actions with these columns", and a mock insert would accept any shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { signApproveToken } from "@/lib/email/newsletter-approve-token";

const SECRET = "approve-secret";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0, unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER, confirmed_at INTEGER, unsubscribed_at INTEGER,
    confirmation_token_hash TEXT, confirmation_expires INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, list TEXT NOT NULL,
    created_at INTEGER NOT NULL, unsubscribed_at INTEGER, UNIQUE (subscriber_id, list)
  );
  CREATE TABLE email_suppression_list (email TEXT PRIMARY KEY, reason TEXT, created_at INTEGER);
  CREATE TABLE newsletter_issues (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, html TEXT NOT NULL,
    sent_at INTEGER, audience TEXT NOT NULL DEFAULT 'weekend', created_at INTEGER
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload_json TEXT,
    created_at INTEGER NOT NULL
  );
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** Throw on the Nth enqueue (1-based) to simulate a partial broadcast. */
let failOnCall = 0;
const enqueueEmailMock = vi.fn(async (_job?: unknown) => {
  if (failOnCall && enqueueEmailMock.mock.calls.length === failOnCall) {
    throw new Error("queue unavailable");
  }
});
const logErrorMock = vi.fn(async (_db: unknown, _e: unknown) => {});
let authz: { authorized: boolean; userId?: string | null } = { authorized: true, userId: "a1" };

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({
    NEWSLETTER_SEND_ENABLED: "true",
    VENDOR_DIGEST_SEND_ENABLED: "true",
    AUTH_SECRET: SECRET,
    MAILING_ADDRESS: "18 Main ST, Phillips, ME 04966",
  }),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: (j: unknown) => enqueueEmailMock(j) }));
vi.mock("@/lib/logger", () => ({
  logError: (d: unknown, e: unknown) => logErrorMock(d, e),
}));
// The vendor-digest route's event selection needs the whole events schema; what
// is under test here is only the audit row, so the content is stubbed.
vi.mock("@/lib/newsletter/new-this-week", () => ({
  selectNewThisWeekEvents: async () => [{ id: "e1" }, { id: "e2" }],
}));
vi.mock("@/lib/email/vendor-digest", () => ({
  renderVendorDigestContent: () => "<p>two new shows</p>",
}));
vi.mock("@/lib/api-auth", () => ({
  getAuthorizedSession: async () => authz,
  internalKeyMatches: () => false,
}));

const { POST: approvePOST } = await import("@/app/api/newsletter/approve/route");
const { POST: sendPOST } = await import("@/app/api/admin/newsletter/send/route");
const { POST: vendorPOST } = await import("@/app/api/admin/newsletter/vendor-digest/route");

const EMAILS = ["a@example.com", "b@example.com", "c@example.com"];

function seedSubscribers(list = "weekend", emails = EMAILS) {
  for (const email of emails) {
    raw
      .prepare(
        `INSERT INTO newsletter_subscribers (id,email,confirmed,unsubscribed) VALUES (?,?,1,0)`
      )
      .run(email, email);
    raw
      .prepare(
        `INSERT INTO newsletter_list_subscriptions (id,subscriber_id,list,created_at) VALUES (?,?,?,0)`
      )
      .run(`${email}-${list}`, email, list);
  }
}

function seedIssue(slug: string) {
  raw
    .prepare(
      `INSERT INTO newsletter_issues (id,slug,subject,html,sent_at,audience,created_at) VALUES (?,?,?,?,NULL,'weekend',0)`
    )
    .run(slug, slug, "This Weekend at the Fair", "<p>body</p>");
}

async function approve(slug: string) {
  const token = await signApproveToken(slug, SECRET, new Date());
  return approvePOST(
    new NextRequest("http://localhost/api/newsletter/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    })
  );
}

function send(body: Record<string, unknown>) {
  return sendPOST(
    new NextRequest("http://localhost/api/admin/newsletter/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "This Weekend at the Fair",
        content_html: "<p>body</p>",
        audience: "weekend",
        ...body,
      }),
    }),
    { params: Promise.resolve({}) }
  );
}

type AuditRow = {
  action: string;
  actor_user_id: string | null;
  target_type: string;
  target_id: string;
  payload_json: string;
};
const auditRows = () =>
  raw
    .prepare(
      `SELECT action, actor_user_id, target_type, target_id, payload_json FROM admin_actions`
    )
    .all() as AuditRow[];
const statusOf = (res: Response) =>
  new URL(res.headers.get("location") ?? "http://x/").searchParams.get("status");

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  enqueueEmailMock.mockClear();
  logErrorMock.mockClear();
  failOnCall = 0;
  authz = { authorized: true, userId: "a1" };
  seedSubscribers();
});

describe("approve route (one-tap) — OPE-1722", () => {
  it("a broadcast writes exactly one newsletter.broadcast row, via approve_token", async () => {
    seedIssue("this-weekend-2026-12-04");
    const res = await approve("this-weekend-2026-12-04");
    expect(statusOf(res)).toBe("sent");
    expect(enqueueEmailMock).toHaveBeenCalledTimes(3);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "newsletter.broadcast",
      actor_user_id: null,
      target_type: "newsletter_issue",
      target_id: "this-weekend-2026-12-04",
    });
    expect(JSON.parse(rows[0].payload_json)).toEqual({
      route: "approve",
      via: "approve_token",
      audience: "weekend",
      subject: "This Weekend at the Fair",
      total: 3,
      queued: 3,
      enqueue_failed: false,
    });
  });

  it("a lost latch (already sent) writes NO row", async () => {
    seedIssue("this-weekend-2026-12-04");
    raw.prepare(`UPDATE newsletter_issues SET sent_at = 1`).run();
    const res = await approve("this-weekend-2026-12-04");
    expect(statusOf(res)).toBe("already_sent");
    expect(auditRows()).toHaveLength(0);
  });

  it("a partial enqueue failure still writes the row, with queued < total", async () => {
    seedIssue("this-weekend-2026-12-04");
    failOnCall = 3;
    const res = await approve("this-weekend-2026-12-04");
    expect(statusOf(res)).toBe("server_error");
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({
      total: 3,
      queued: 2,
      enqueue_failed: true,
    });
  });

  it("an audit insert that throws leaves the send untouched, and is logged", async () => {
    seedIssue("this-weekend-2026-12-04");
    raw.exec(`DROP TABLE admin_actions`);
    const res = await approve("this-weekend-2026-12-04");
    expect(statusOf(res)).toBe("sent");
    expect(enqueueEmailMock).toHaveBeenCalledTimes(3);
    const lost = logErrorMock.mock.calls.find(
      (c) =>
        (c[1] as { context?: { auditAction?: string } }).context?.auditAction ===
        "newsletter.broadcast"
    );
    expect(lost, "the lost audit row must be logged, not swallowed").toBeDefined();
  });
});

describe("/api/admin/newsletter/send — OPE-1722", () => {
  it("an admin-session broadcast writes one row carrying the user id", async () => {
    const res = await send({});
    expect(res.status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe("a1");
    expect(rows[0].target_type).toBe("newsletter_issue");
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({
      route: "admin_send",
      via: "admin_session",
      total: 3,
      queued: 3,
      enqueue_failed: false,
    });
  });

  it("an X-Internal-Key broadcast (the MCP tool) records via internal_key, no user", async () => {
    authz = { authorized: true, userId: null };
    await send({});
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBeNull();
    expect(JSON.parse(rows[0].payload_json).via).toBe("internal_key");
  });

  it("a test_recipient send writes NO row (and a preview writes none either)", async () => {
    const t = await send({ test_recipient: "john@example.com" });
    expect(t.status).toBe(200);
    const p = await send({ preview_only: true });
    expect(p.status).toBe(200);
    // Landmark beside the negative: the test send DID enqueue.
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("a partial enqueue failure writes the row with the queued count", async () => {
    failOnCall = 2;
    const res = await send({});
    expect(res.status).toBe(502);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ queued: 1, enqueue_failed: true });
  });

  it("an audit insert that throws leaves the 200 response unchanged", async () => {
    raw.exec(`DROP TABLE admin_actions`);
    const res = await send({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recipients: number; mode: string };
    expect(body).toMatchObject({ mode: "broadcast", recipients: 3 });
  });
});

const VENDOR_EMAILS = ["v0@example.com", "v1@example.com"];
function vendorDigest(body: Record<string, unknown>) {
  return vendorPOST(
    new NextRequest("http://localhost/api/admin/newsletter/vendor-digest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

describe("/api/admin/newsletter/vendor-digest — OPE-1722 (the third door)", () => {
  beforeEach(() => seedSubscribers("vendor", VENDOR_EMAILS));

  it("a confirmed broadcast writes one row, route vendor_digest, audience vendor", async () => {
    authz = { authorized: true, userId: null }; // the MCP send_vendor_digest tool
    const res = await vendorDigest({ require_human_confirmation: "GO" });
    const body = (await res.json()) as { sent: boolean; broadcast: boolean; queued: number };
    expect(body).toMatchObject({ sent: true, broadcast: true, queued: 2 });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBeNull();
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({
      route: "vendor_digest",
      via: "internal_key",
      audience: "vendor",
      total: 2,
      queued: 2,
      enqueue_failed: false,
    });
  });

  it("an un-tokened call (compose + persist only) and a test send write NO row", async () => {
    const refused = (await (await vendorDigest({})).json()) as { reason: string };
    expect(refused.reason).toBe("missing_human_confirmation");
    const test = (await (await vendorDigest({ test_recipient: "john@example.com" })).json()) as {
      sent: boolean;
    };
    expect(test.sent).toBe(true);
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1); // landmark: the test send DID go
    expect(auditRows()).toHaveLength(0);
  });

  it("a partial enqueue failure still writes the row", async () => {
    failOnCall = 2;
    const res = await vendorDigest({ require_human_confirmation: "GO" });
    expect(res.status).toBe(500);
    expect(JSON.parse(auditRows()[0].payload_json)).toMatchObject({
      queued: 1,
      enqueue_failed: true,
    });
  });
});
