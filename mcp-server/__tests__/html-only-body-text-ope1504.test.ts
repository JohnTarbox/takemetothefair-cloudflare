/**
 * OPE-1504 — an inbound message with NO text/plain part is stored with a
 * body_text derived from its HTML, and the classifier reads that body.
 *
 * Specimen: inbound `38eebf26`, Elizabeth Wessig's iPhone Mail reply on the
 * Paradise City "Tickets??" thread (2026-10-09). Apple Mail sent HTML only, so
 * body_text and the excerpt were NULL, the classifier decided from the subject
 * line alone, and the thread view showed an empty message for 11 days.
 *
 * These drive `handleInboundEmail` for real — PostalMime parse included — and
 * capture what the classifier was handed, because "the row has a body" and
 * "the classifier saw the body" are two different facts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { inboundEmails } from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: async () => {} }));

const classifierInputs: { subject: string; bodyText: string }[] = [];
vi.mock("../src/intent-classifier.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/intent-classifier.js")>();
  return {
    ...real,
    // This test is about capture, not routing: any intent that stores a row
    // will do, and whatever runs after the insert is left to settle.
    classifyIntent: vi.fn(async (_ai: unknown, input: { subject: string; bodyText: string }) => {
      classifierInputs.push({ subject: input.subject, bodyText: input.bodyText });
      return {
        intents: [
          {
            intent: "spam",
            subIntent: null,
            confidence: 0.99,
            rationale: "test",
            refUrl: null,
            refEventClue: null,
          },
        ],
        version: real.CLASSIFIER_VERSION,
        fromAi: true,
        startedAt: 0,
        finishedAt: 0,
      };
    }),
  };
});

const { handleInboundEmail } = await import("../src/email-handler.js");

const FROM = "reader.sample@example.org";

function makeKv() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

function env() {
  return {
    DB: {} as D1Database,
    // Present so computeRouting reaches the (mocked) classifier rather than
    // the no-AI address-only branch.
    AI: {},
    OAUTH_KV: makeKv(),
    MAIN_APP_URL: "https://main.example.test",
    INTERNAL_API_KEY: "k",
  };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

function inbound(raw: string) {
  return {
    from: FROM,
    to: "hello@meetmeatthefair.com",
    raw,
    rawSize: raw.length,
    headers: new Headers(),
    forward: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    setReject: vi.fn(),
  };
}

/** The Apple Mail HTML-only shape: one text/html part, no text/plain at all. */
const APPLE_MAIL_HTML = [
  '<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8">',
  "<style>body { font-family: -apple-system; }</style></head>",
  '<body dir="auto">Thank you!<br id="lineBreakAtBeginningOfSignature">',
  '<div dir="ltr">Sent from my iPhone</div>',
  '<div dir="ltr"><br><blockquote type="cite">On Oct 8, 2026, at 9:01 AM, ',
  "Meet Me at the Fair &lt;hello@meetmeatthefair.com&gt; wrote:<br><br></blockquote></div>",
  '<blockquote type="cite"><div dir="ltr">Tickets are sold at the gate &amp; online.</div>',
  "</blockquote></body></html>",
].join("");

function message(parts: { html?: string; text?: string }): string {
  const head = [
    `From: Reader Sample <${FROM}>`,
    "To: hello@meetmeatthefair.com",
    "Subject: Re: Tickets??",
    "Message-ID: <ope1504-" + Math.random().toString(36).slice(2) + "@example.org>",
    "MIME-Version: 1.0",
  ];
  if (parts.html !== undefined && parts.text === undefined) {
    return [...head, "Content-Type: text/html; charset=utf-8", "", parts.html, ""].join("\r\n");
  }
  return [
    ...head,
    'Content-Type: multipart/alternative; boundary="ALT"',
    "",
    "--ALT",
    "Content-Type: text/plain; charset=utf-8",
    "",
    parts.text ?? "",
    "--ALT",
    "Content-Type: text/html; charset=utf-8",
    "",
    parts.html ?? "",
    "--ALT--",
    "",
  ].join("\r\n");
}

async function storedRow() {
  await Promise.allSettled(pending);
  const rows = await harness.db
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.fromAddress, FROM));
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeEach(() => {
  ({ db: harness.db } = createTestDb());
  classifierInputs.length = 0;
  pending.length = 0;
});

describe("OPE-1504 — HTML-only inbound mail gets a body_text", () => {
  it("ACCEPTANCE: the Apple Mail HTML-only reply is stored with body_text starting 'Thank you!'", async () => {
    await handleInboundEmail(
      inbound(message({ html: APPLE_MAIL_HTML })) as never,
      env() as never,
      ctx as never
    );
    const row = await storedRow();

    expect(row.bodyText).toMatch(/^Thank you!/);
    expect(row.bodyTextExcerpt).toMatch(/^Thank you!/);
    // Line breaks kept, entities decoded, <style>/<head> dropped.
    expect(row.bodyText).toContain("\nSent from my iPhone");
    expect(row.bodyText).toContain("Tickets are sold at the gate & online.");
    expect(row.bodyText).not.toContain("font-family");
    expect(row.bodyText).not.toMatch(/<\/?(html|head|body|div|br|blockquote|style)\b/i);
    // …while an escaped address in the copy decodes to its literal text.
    expect(row.bodyText).toContain("Meet Me at the Fair <hello@meetmeatthefair.com> wrote:");
    // The HTML is still stored as received.
    expect(row.bodyHtml).toContain('<body dir="auto">Thank you!');
    // A reader can tell the text was derived.
    expect(JSON.parse(row.captureMeta ?? "null")).toEqual({ body_text_source: "html" });
  });

  it("ACCEPTANCE: the classifier is handed the derived body, not an empty string", async () => {
    await handleInboundEmail(
      inbound(message({ html: APPLE_MAIL_HTML })) as never,
      env() as never,
      ctx as never
    );
    expect(classifierInputs).toHaveLength(1);
    expect(classifierInputs[0].subject).toBe("Re: Tickets??");
    expect(classifierInputs[0].bodyText).toMatch(/^Thank you!/);
  });

  it("a message WITH a text/plain part is unchanged: its own text, no capture_meta", async () => {
    // The positive landmark: the derivation fires only when the text part is
    // missing, never as a replacement for one the sender wrote.
    await handleInboundEmail(
      inbound(message({ text: "Plain words from the sender.", html: APPLE_MAIL_HTML })) as never,
      env() as never,
      ctx as never
    );
    const row = await storedRow();
    expect(row.bodyText?.trim()).toBe("Plain words from the sender.");
    expect(row.captureMeta).toBeNull();
    expect(classifierInputs[0].bodyText.trim()).toBe("Plain words from the sender.");
  });

  it("a whitespace-only text/plain part counts as missing", async () => {
    await handleInboundEmail(
      inbound(message({ text: "   ", html: APPLE_MAIL_HTML })) as never,
      env() as never,
      ctx as never
    );
    const row = await storedRow();
    expect(row.bodyText).toMatch(/^Thank you!/);
    expect(JSON.parse(row.captureMeta ?? "null")).toEqual({ body_text_source: "html" });
  });

  it("HTML with no visible text stays NULL — derived emptiness is not dressed up as a body", async () => {
    await handleInboundEmail(
      inbound(
        message({ html: '<html><head><style>p{}</style></head><body><img src="x"></body></html>' })
      ) as never,
      env() as never,
      ctx as never
    );
    const row = await storedRow();
    expect(row.bodyText).toBeNull();
    expect(row.captureMeta).toBeNull();
  });
});
