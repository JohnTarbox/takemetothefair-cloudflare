/**
 * OPE-1719 — a large newsletter issue reaches the queue, and a queue refusal is
 * a clean JSON error, never an unhandled 500.
 *
 * The Nov 27 weekend issue (88,126 chars of HTML) was refused by
 * `EMAIL_JOBS.send()` on both attempts — "message length of 136334 bytes
 * exceeds limit of 128000 bytes (10204)" — and the route 500'd unhandled.
 *
 * The REAL `enqueueEmail` runs here (only the queue binding is faked), and the
 * fake enforces the limit with `v8.serialize`: Cloudflare Queues serializes a
 * `send()` body with V8's structured clone by default, so this measures the
 * same quantity the platform does, not our own estimate of it.
 *
 * LANDMARK: the fixture's per-recipient message is shown to be over the limit
 * once its spilled body is put back, so "every message fits" cannot pass on a
 * fixture too small to have needed the fix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import { estimateQueueMessageBytes } from "@takemetothefair/db-schema/email-job-body";

const LIMIT = 128_000;

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
// The spill table comes from its migration, so the test runs the SQL prod runs.
const SPILL_SQL = readFileSync(
  join(process.cwd(), "drizzle/0442_ope1719_email_job_bodies.sql"),
  "utf8"
);

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const queued: Array<Record<string, unknown>> = [];
let failOnSend: number | null = null; // 1-based index of the send that throws
const logged: Array<Record<string, unknown>> = [];

const fakeQueue = {
  send: async (msg: Record<string, unknown>) => {
    if (failOnSend !== null && queued.length + 1 >= failOnSend) {
      throw new Error("queue unavailable (test)");
    }
    const bytes = serialize(msg).length;
    if (bytes > LIMIT) {
      throw new Error(`message length of ${bytes} bytes exceeds limit of ${LIMIT} bytes (10204)`);
    }
    queued.push(msg);
  },
};

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
  hasRole: (s: { user?: { role?: string } } | null, r: string) => s?.user?.role === r,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({
    NEWSLETTER_SEND_ENABLED: "true",
    AUTH_SECRET: "s",
    MAILING_ADDRESS: "18 Main ST, Phillips, ME 04966",
    EMAIL_JOBS: fakeQueue,
  }),
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {} }) }));
vi.mock("@/lib/logger", () => ({
  logError: async (_db: unknown, e: Record<string, unknown>) => void logged.push(e),
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

const EMAILS = ["a@example.com", "b@example.com", "c@example.com"];
// Nov-27-shaped: ~88K chars, typographic punctuation (a single em-dash makes
// V8 store the whole string at two bytes per char).
const PARA = "<p>Holiday Craft Fair — Saturday 9–3 at the Grange Hall, Main Street.</p>\n";
const BIG_HTML = PARA.repeat(Math.ceil(88_126 / PARA.length)).slice(0, 88_126 - 200);

const broadcast = () =>
  call({
    subject: "This Weekend at the Fair — Nov 27",
    content_html: BIG_HTML,
    audience: "weekend",
  });

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  raw["exec"](SPILL_SQL);
  db = drizzle(raw, { schema });
  for (const e of EMAILS) {
    raw
      .prepare(
        "INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed) VALUES (?,?,1,0)"
      )
      .run(e, e);
    raw
      .prepare(
        "INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at) VALUES (?,?,'weekend',0)"
      )
      .run(`${e}-w`, e);
  }
  queued.length = 0;
  logged.length = 0;
  failOnSend = null;
  authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
});

describe("OPE-1719 — an 88 KB issue fits the queue", () => {
  it("broadcasts to every recipient; every message is under 128,000 bytes", async () => {
    const res = await broadcast();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recipients: number }).recipients).toBe(EMAILS.length);

    expect(queued).toHaveLength(EMAILS.length);
    for (const m of queued) {
      expect(serialize(m).length).toBeLessThanOrEqual(LIMIT);
      expect(m.bodyRef).toEqual(expect.any(String));
    }
    const bodies = raw.prepare("SELECT id, html FROM email_job_bodies").all() as Array<{
      id: string;
      html: string;
    }>;
    expect(bodies).toHaveLength(EMAILS.length);
    expect(bodies.every((b) => b.html.includes("Holiday Craft Fair"))).toBe(true);

    const issue = raw.prepare("SELECT sent_at FROM newsletter_issues").get() as {
      sent_at: number | null;
    };
    expect(issue.sent_at).not.toBeNull();
  });

  it("LANDMARK: with its body put back, each message is over the limit", async () => {
    await broadcast();
    const m = queued[0];
    const row = raw
      .prepare("SELECT html, text FROM email_job_bodies WHERE id = ?")
      .get(m.bodyRef) as {
      html: string;
      text: string;
    };
    const unspilled = { ...m, html: row.html, text: row.text, bodyRef: undefined };
    expect(serialize(unspilled).length).toBeGreaterThan(LIMIT);
    // The spill threshold rests on the estimate being an UPPER bound of what
    // V8 actually writes; check it against the real serializer on both shapes.
    expect(estimateQueueMessageBytes(unspilled)).toBeGreaterThanOrEqual(
      serialize(unspilled).length
    );
    expect(estimateQueueMessageBytes(m)).toBeGreaterThanOrEqual(serialize(m).length);
  });
});

describe("OPE-1719 — a queue refusal is a JSON 502, not an unhandled 500", () => {
  it("nothing queued: 502 with queued 0, and the issue is NOT marked sent", async () => {
    failOnSend = 1;
    const res = await broadcast();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "enqueue_failed", queued: 0, total: EMAILS.length });

    const issue = raw.prepare("SELECT sent_at FROM newsletter_issues").get() as {
      sent_at: number | null;
    };
    expect(issue.sent_at).toBeNull();
    expect(
      logged.some((l) => l.level === "error" && l.source === "/api/admin/newsletter/send")
    ).toBe(true);
  });

  it("partial: 502 names how many were queued, and sent_at stays (they will be mailed)", async () => {
    failOnSend = 2;
    const res = await broadcast();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ queued: 1, total: EMAILS.length });
    const issue = raw.prepare("SELECT sent_at FROM newsletter_issues").get() as {
      sent_at: number | null;
    };
    expect(issue.sent_at).not.toBeNull();
  });
});
