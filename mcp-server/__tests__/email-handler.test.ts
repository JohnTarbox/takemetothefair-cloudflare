/**
 * Unit tests for the inbound-email handler's pure helpers.
 *
 * We test the parts we can without mocking the full Cloudflare environment:
 *   - pickPrimaryUrl: text + HTML URL extraction
 *   - checkSenderRateLimit: KV-backed counter
 *   - buildReply: outbound auto-reply templating
 *
 * The end-to-end handleInboundEmail flow is left for an integration test —
 * it requires mocking PostalMime + fetch + ForwardableEmailMessage, which
 * is more setup than the value justifies for a public-beta V1.
 */
import { describe, expect, it, vi } from "vitest";
import { pickPrimaryUrl, checkSenderRateLimit, buildReply } from "../src/email-handler.js";

describe("pickPrimaryUrl — happy path", () => {
  it("extracts the first http(s) URL from a text body", () => {
    const text =
      "Hey — I'd love to add this event: https://fryeburgfair.org/2026 — happens this fall.";
    expect(pickPrimaryUrl(text, "")).toBe("https://fryeburgfair.org/2026");
  });

  it("strips trailing punctuation that snuck into the URL", () => {
    expect(pickPrimaryUrl("see https://example.com/page.", "")).toBe("https://example.com/page");
    expect(pickPrimaryUrl("(visit https://example.com/x)", "")).toBe("https://example.com/x");
    expect(pickPrimaryUrl("link: https://example.com/y;", "")).toBe("https://example.com/y");
  });

  it("prefers text over HTML when both contain URLs", () => {
    const text = "Submit this: https://fryeburgfair.org";
    const html = '<a href="https://example.com/sig">unsub</a>';
    expect(pickPrimaryUrl(text, html)).toBe("https://fryeburgfair.org/");
  });

  it("falls back to HTML hrefs when text has none", () => {
    const html = '<p>Check it: <a href="https://fryeburgfair.org/2026">Fryeburg</a></p>';
    expect(pickPrimaryUrl("", html)).toBe("https://fryeburgfair.org/2026");
  });
});

describe("pickPrimaryUrl — rejection", () => {
  it("returns null when body has no URLs", () => {
    expect(pickPrimaryUrl("I'd like to submit an event but I forgot the link", "")).toBeNull();
  });

  it("rejects mailto: and other non-http schemes", () => {
    expect(pickPrimaryUrl("reach me at mailto:fair@example.com", "")).toBeNull();
    expect(pickPrimaryUrl("ftp://example.com/file", "")).toBeNull();
  });

  it("ignores file:// and javascript: in HTML hrefs", () => {
    const html =
      '<a href="javascript:void(0)">click</a><a href="https://real.example.com/x">real</a>';
    expect(pickPrimaryUrl("", html)).toBe("https://real.example.com/x");
  });
});

describe("checkSenderRateLimit — KV-backed counter", () => {
  function mockKv(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const puts: Array<{ key: string; value: string; opts?: KVNamespacePutOptions }> = [];
    const kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string, opts?: KVNamespacePutOptions) => {
        store.set(key, value);
        puts.push({ key, value, opts });
      }),
    } as unknown as KVNamespace;
    return { kv, puts, store };
  }

  it("allows first submission and writes count=1 with 24h TTL", async () => {
    const { kv, puts } = mockKv();
    const ok = await checkSenderRateLimit(kv, "alice@example.com");
    expect(ok).toBe(true);
    expect(puts).toEqual([
      {
        key: "email-submit:alice@example.com",
        value: "1",
        opts: { expirationTtl: 86_400 },
      },
    ]);
  });

  it("allows submissions up to the 5/day limit", async () => {
    const { kv } = mockKv({ "email-submit:bob@example.com": "4" });
    expect(await checkSenderRateLimit(kv, "bob@example.com")).toBe(true);
  });

  it("rejects the 6th submission within the window", async () => {
    const { kv, puts } = mockKv({ "email-submit:spam@example.com": "5" });
    const ok = await checkSenderRateLimit(kv, "spam@example.com");
    expect(ok).toBe(false);
    // Critical: must not write back the counter when rejecting — otherwise
    // we'd extend the lockout window indefinitely on each retry.
    expect(puts).toEqual([]);
  });

  it("treats a missing key as count=0", async () => {
    const { kv, puts } = mockKv();
    await checkSenderRateLimit(kv, "newsender@example.com");
    expect(puts[0].value).toBe("1");
  });

  it("treats a corrupt KV value as count=0", async () => {
    const { kv, puts } = mockKv({ "email-submit:weird@example.com": "not-a-number" });
    const ok = await checkSenderRateLimit(kv, "weird@example.com");
    expect(ok).toBe(true);
    expect(puts[0].value).toBe("1");
  });
});

describe("buildReply — auto-reply templating", () => {
  it("subject is prefixed with Re: and clamped to 200 chars", () => {
    const long = "x".repeat(300);
    const msg = buildReply({
      to: "alice@example.com",
      kind: "ok",
      subject: long,
      eventName: "Fryeburg Fair",
      hasAttachments: false,
    });
    expect(msg.subject.startsWith("Re: ")).toBe(true);
    expect(msg.subject.length).toBeLessThanOrEqual(200);
  });

  it("ok reply includes the event name and queue source tag", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "ok",
      subject: "Fryeburg",
      eventName: "Fryeburg Fair 2026",
      hasAttachments: false,
    });
    expect(msg.text).toContain("Fryeburg Fair 2026");
    expect(msg.source).toBe("email:submit-reply");
    expect(msg.to).toBe("alice@example.com");
  });

  it("ok reply with attachments warns we don't process them", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "ok",
      subject: "",
      eventName: "Some Event",
      hasAttachments: true,
    });
    expect(msg.text).toMatch(/don't process attachments/i);
  });

  it("ok reply without attachments doesn't mention them", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "ok",
      subject: "",
      eventName: "Some Event",
      hasAttachments: false,
    });
    expect(msg.text).not.toMatch(/attachment/i);
  });

  it("no-url reply asks the sender to include a link", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "no-url",
      subject: "event idea",
      hasAttachments: false,
    });
    expect(msg.text).toMatch(/URL|link/);
  });

  it("extract-failed reply mentions the URL that failed", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "extract-failed",
      subject: "fair",
      url: "https://broken.example.com/page",
    });
    expect(msg.text).toContain("https://broken.example.com/page");
  });

  it("HTML body is escaped (no raw < or > from user content)", () => {
    const msg = buildReply({
      to: "alice@example.com",
      kind: "ok",
      subject: "<script>alert(1)</script>",
      eventName: "<b>Boldface Fair</b>",
      hasAttachments: false,
    });
    // The event name appears in text body too; ensure HTML body has it escaped.
    expect(msg.html).not.toContain("<b>Boldface");
    expect(msg.html).toContain("&lt;b&gt;Boldface");
  });
});
