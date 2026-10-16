/**
 * OPE-1392 (TPL-1) — the newsletter send route stores and mails the SANITIZED
 * body, never the raw `content_html` it was handed.
 *
 * The body is composed by an agent from DB event names, which arrive through
 * the public suggest_event path. Before this, the route upserted
 * `newsletter_issues.html = content_html` verbatim — and the public
 * /newsletter/[slug] page renders that column with dangerouslySetInnerHTML.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const insertedValues: Array<Record<string, unknown>> = [];
const conflictSets: Array<Record<string, unknown>> = [];
const insertMock = vi.fn(() => ({
  values: (v: Record<string, unknown>) => {
    insertedValues.push(v);
    return {
      onConflictDoUpdate: (c: { set: Record<string, unknown> }) => {
        conflictSets.push(c.set);
        return Promise.resolve();
      },
    };
  },
}));
const enqueueArgs: Array<Record<string, unknown>> = [];

vi.mock("@/lib/api-auth", () => ({
  getAuthorizedSession: async () => ({ authorized: true, userId: "admin-1" }),
  internalKeyMatches: () => true,
}));
vi.mock("@/lib/logger", () => ({ logError: async () => {} }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({ insert: insertMock }),
  getCloudflareEnv: () => ({
    NEWSLETTER_SEND_ENABLED: "false",
    NEWSLETTER_UNSUBSCRIBE_SECRET: "s3cret",
  }),
}));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://meetmeatthefair.com" }));
vi.mock("@/lib/email/newsletter-broadcast", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    selectBroadcastRecipients: async () => ["a@example.com"],
    enqueueNewsletterDigest: async (args: Record<string, unknown>) => {
      enqueueArgs.push(args);
      return (args.recipients as string[]).length;
    },
  };
});

const { POST } = await import("../route");

function call(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/admin/newsletter/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({}) } as never
  );
}

const HOSTILE =
  '<p style="color:#1f3a2d">Fair <img src="x" onerror="alert(1)"></p>' +
  "<script>alert(document.cookie)</script>" +
  '<a href="javascript:alert(1)">tickets</a>' +
  '<svg onload="alert(1)"></svg>' +
  '<a href="https://meetmeatthefair.com/events/x">ok</a>';
const SANITIZED =
  '<p style="color:#1f3a2d">Fair <img></p><a>tickets</a>' +
  '<a href="https://meetmeatthefair.com/events/x">ok</a>';

beforeEach(() => {
  insertedValues.length = 0;
  conflictSets.length = 0;
  enqueueArgs.length = 0;
});

describe("POST /api/admin/newsletter/send — OPE-1392 sanitizes at write", () => {
  it("stores (insert AND upsert branch) and enqueues the sanitized body", async () => {
    const res = await call({
      audience: "weekend",
      subject: "This Weekend\r\nBcc: x@evil.test",
      content_html: HOSTILE,
      test_recipient: "me@example.com",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.html_sanitized).toBe(true);

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].html).toBe(SANITIZED);
    expect(insertedValues[0].subject).toBe("This Weekend Bcc: x@evil.test");
    expect(conflictSets[0].html).toBe(SANITIZED);
    expect(enqueueArgs[0].contentHtml).toBe(SANITIZED);
    expect(enqueueArgs[0].subject).toBe("This Weekend Bcc: x@evil.test");
  });

  it("a clean body is stored unchanged and reported as not sanitized", async () => {
    const clean = '<p style="margin:0;">Hello &amp; welcome</p>';
    const res = await call({
      audience: "weekend",
      subject: "Hi",
      content_html: clean,
      test_recipient: "me@example.com",
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.html_sanitized).toBe(false);
    expect(insertedValues[0].html).toBe(clean);
  });

  it("preview reports html_sanitized without writing anything", async () => {
    const res = await call({
      audience: "weekend",
      subject: "Hi",
      content_html: HOSTILE,
      preview_only: true,
    });
    const json = (await res.json()) as { issue: Record<string, unknown> };
    expect(json.issue.html_sanitized).toBe(true);
    expect(json.issue.html_length).toBe(SANITIZED.length);
    expect(insertedValues).toHaveLength(0);
  });

  it("a body that is nothing but a script is refused as empty", async () => {
    const res = await call({
      audience: "weekend",
      subject: "Hi",
      content_html: "<script>alert(1)</script>",
      test_recipient: "me@example.com",
    });
    expect(res.status).toBe(400);
    expect(insertedValues).toHaveLength(0);
  });
});
