/**
 * OPE-795 — the one-tap approve broadcast follows the ISSUE's audience.
 *
 * This is the second of the two send paths, and the one nobody named. Adding an
 * `audience` selector to /api/admin/newsletter/send without touching this route
 * would have *created* a live defect rather than only leaving one: the send
 * route mints the approve token on a test/preview send, so a vendor issue
 * previewed to John would carry a button whose click broadcast it to the 39
 * attendee subscribers. Before OPE-795 that was unreachable — the send route
 * could only ever write `audience:'weekend'` issues — which is exactly why it
 * was invisible.
 *
 * Real SQLite, for the reason `newsletter-lists.test.ts` gives: the failure mode
 * is "mailed the wrong audience", and a mock chain returns whatever list you
 * hand it whichever audience the route asked for.
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
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const enqueueEmailMock = vi.fn(async (_job?: unknown) => {});

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({
    NEWSLETTER_SEND_ENABLED: "true",
    AUTH_SECRET: SECRET,
    MAILING_ADDRESS: "18 Main ST, Phillips, ME 04966",
  }),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: (j: unknown) => enqueueEmailMock(j) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const { POST } = await import("../route");

const VENDOR_EMAILS = ["v0@example.com", "v1@example.com", "v2@example.com"];
const WEEKEND_EMAILS = Array.from({ length: 39 }, (_, i) => `w${i}@example.com`);

function seedSubscriber(email: string, list: string) {
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

function seedIssue(slug: string, audience: string) {
  raw
    .prepare(
      `INSERT INTO newsletter_issues (id,slug,subject,html,sent_at,audience,created_at) VALUES (?,?,?,?,NULL,?,0)`
    )
    .run(slug, slug, "An issue", "<p>body</p>", audience);
}

async function approve(slug: string) {
  const token = await signApproveToken(slug, SECRET, new Date());
  return POST(
    new NextRequest("http://localhost/api/newsletter/approve", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    })
  );
}

const enqueuedTo = () => enqueueEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to).sort();

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  enqueueEmailMock.mockClear();
  for (const e of VENDOR_EMAILS) seedSubscriber(e, "vendor");
  for (const e of WEEKEND_EMAILS) seedSubscriber(e, "weekend");
});

describe("POST /api/newsletter/approve — broadcasts to the issue's own audience (OPE-795)", () => {
  it("a vendor issue reaches the 3 vendor subscribers and NO attendee", async () => {
    seedIssue("new-this-week-2026-09-04", "vendor");
    const res = await approve("new-this-week-2026-09-04");
    expect(res.status).toBe(303);
    expect(enqueuedTo()).toEqual([...VENDOR_EMAILS].sort());
    // The defect this closes, stated as the assertion: not one of the 39.
    expect(enqueuedTo().some((e) => e.startsWith("w"))).toBe(false);
  });

  it("a weekend issue still reaches the 39 attendees and no vendor", async () => {
    seedIssue("this-weekend-2026-09-04", "weekend");
    await approve("this-weekend-2026-09-04");
    const to = enqueuedTo();
    expect(to).toHaveLength(39);
    expect(to.some((e) => e.startsWith("v"))).toBe(false);
  });

  it("a vendor issue renders the vendor wordmark, not the attendee one", async () => {
    seedIssue("new-this-week-2026-09-04", "vendor");
    await approve("new-this-week-2026-09-04");
    const html = (enqueueEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("New This Week");
    expect(html).not.toContain("This Weekend at the Fair");
  });

  it("an unrecognised audience refuses BEFORE the latch, leaving the issue re-approvable", async () => {
    // The latch is a one-way claim on sent_at. A refusal after it would mark the
    // issue broadcast while sending to nobody, and it could never be sent again.
    seedIssue("mystery-2026-09-04", "subscribers-of-some-kind");
    const res = await approve("mystery-2026-09-04");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("status=server_error");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
    const row = raw
      .prepare(`SELECT sent_at FROM newsletter_issues WHERE slug = ?`)
      .get("mystery-2026-09-04") as { sent_at: number | null };
    expect(row.sent_at).toBeNull();
  });
});
