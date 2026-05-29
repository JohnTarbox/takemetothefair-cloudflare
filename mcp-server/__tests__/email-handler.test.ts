/**
 * Unit tests for the inbound-email entrypoint's pure helpers
 * (pickPrimaryUrl, checkSenderRateLimit). Auto-reply templating moved
 * to email-reply-builder.test.ts after the multi-intent refactor.
 *
 * The end-to-end handleInboundEmail flow is left for an integration test —
 * it requires mocking PostalMime + fetch + ForwardableEmailMessage +
 * the workflow binding, which is more setup than the value justifies.
 */
import { describe, expect, it, vi } from "vitest";
import {
  pickPrimaryUrl,
  extractAllUrls,
  checkSenderRateLimit,
  computeRateLimit,
} from "../src/email-handler.js";

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

describe("extractAllUrls — B1 multi-URL", () => {
  it("returns multiple distinct text URLs in document order", () => {
    const text =
      "First: https://a.example.com\nSecond: https://b.example.com\nThird: https://c.example.com";
    expect(extractAllUrls(text, "", 10)).toEqual([
      "https://a.example.com/",
      "https://b.example.com/",
      "https://c.example.com/",
    ]);
  });

  it("deduplicates URLs that appear in both text and html", () => {
    const text = "https://shared.example.com is the event";
    const html =
      '<a href="https://shared.example.com">link</a><a href="https://other.example.com">other</a>';
    const result = extractAllUrls(text, html, 10);
    expect(result).toContain("https://shared.example.com/");
    expect(result).toContain("https://other.example.com/");
    // Shared URL should appear exactly once.
    expect(result.filter((u) => u === "https://shared.example.com/")).toHaveLength(1);
  });

  it("hard-caps at the requested limit (10 default)", () => {
    const text = Array.from({ length: 15 }, (_, i) => `https://e${i}.example.com`).join("\n");
    const result = extractAllUrls(text, "", 10);
    expect(result).toHaveLength(10);
    // First 10 URLs preserved, last 5 dropped.
    expect(result[0]).toBe("https://e0.example.com/");
    expect(result[9]).toBe("https://e9.example.com/");
  });

  it("returns empty array when no URLs anywhere", () => {
    expect(extractAllUrls("no urls in this body", "", 10)).toEqual([]);
  });

  it("returns a single-element array when only one URL is present", () => {
    // multi-URL workflow falls back to single-URL path on .length<2;
    // this case just verifies the helper itself.
    expect(extractAllUrls("just https://only.example.com here", "", 10)).toEqual([
      "https://only.example.com/",
    ]);
  });

  it("custom cap parameter respected (e.g. cap=3)", () => {
    const text = "a https://a.com b https://b.com c https://c.com d https://d.com";
    expect(extractAllUrls(text, "", 3)).toHaveLength(3);
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

  it("respects the explicit limit argument (admin tier = 100/day)", async () => {
    // Counter at 50 with admin's 100 limit → still allowed
    const { kv } = mockKv({ "email-submit:admin@example.com": "50" });
    expect(await checkSenderRateLimit(kv, "admin@example.com", 100)).toBe(true);
  });

  it("rejects when count meets the explicit limit, even above the 5 floor", async () => {
    // Counter at 100 with admin's 100 limit → blocked
    const { kv, puts } = mockKv({ "email-submit:admin@example.com": "100" });
    const ok = await checkSenderRateLimit(kv, "admin@example.com", 100);
    expect(ok).toBe(false);
    // Don't write back the counter on rejection (same invariant as the
    // default-limit case): preserves the lockout window without extending it.
    expect(puts).toEqual([]);
  });
});

describe("computeRateLimit — per-sender tier policy", () => {
  it("returns the anonymous floor (5) when no user row exists", () => {
    expect(computeRateLimit(null)).toBe(5);
  });

  it("returns the anonymous floor for an unverified user, regardless of role", () => {
    // Critical: prevents a "create user with role=ADMIN, never verify,
    // send spam at admin allowance" exploit.
    expect(computeRateLimit({ role: "ADMIN", emailVerified: null })).toBe(5);
    expect(computeRateLimit({ role: "PROMOTER", emailVerified: null })).toBe(5);
  });

  it("returns 10 for a verified USER", () => {
    expect(computeRateLimit({ role: "USER", emailVerified: new Date() })).toBe(10);
  });

  it("returns 20 for a verified VENDOR", () => {
    expect(computeRateLimit({ role: "VENDOR", emailVerified: new Date() })).toBe(20);
  });

  it("returns 30 for a verified PROMOTER", () => {
    expect(computeRateLimit({ role: "PROMOTER", emailVerified: new Date() })).toBe(30);
  });

  it("returns 100 for a verified ADMIN", () => {
    expect(computeRateLimit({ role: "ADMIN", emailVerified: new Date() })).toBe(100);
  });

  it("returns the anonymous floor for an unrecognized role (defense against schema drift)", () => {
    expect(computeRateLimit({ role: "WHATEVER", emailVerified: new Date() })).toBe(5);
  });
});

// K1 host-denylist regressions (analyst 2026-05-29 PM). Forwarded
// Mailchimp newsletters and other ESP-wrapped emails carry tracking-
// redirect URLs (https://us.list-manage.com/...) before the actual
// event URL. Without the denylist, the workflow's URL-fetch branch
// fetched the tracker page, got zero events, and replied extract-
// failed. With the denylist, the tracker URL is skipped: either the
// next real URL wins, or parsedUrl ends up null and the message
// routes to the free-text branch (which extracts cleanly from the
// body the sender actually wrote).
describe("pickPrimaryUrl — K1 host denylist", () => {
  it("skips a Mailchimp click-tracker (us.list-manage.com) when a real URL follows", () => {
    const text =
      "Register: https://us.list-manage.com/track/click?u=abc&id=def\n" +
      "More: https://winthroparts.org/festival";
    expect(pickPrimaryUrl(text, "")).toBe("https://winthroparts.org/festival");
  });

  it("returns null when only a denylisted URL is present (forces free-text branch)", () => {
    const text = "Please register: https://us.list-manage.com/track/click?u=abc";
    expect(pickPrimaryUrl(text, "")).toBeNull();
  });

  it("skips bit.ly / t.co / tinyurl regardless of order", () => {
    expect(
      pickPrimaryUrl("RSVP: https://bit.ly/abc — details https://winthroparts.org/x", "")
    ).toBe("https://winthroparts.org/x");
  });

  it("skips denylisted href in HTML body too", () => {
    const html =
      '<a href="https://us.list-manage.com/track/abc">Register</a>' +
      '<a href="https://realfair.example.com/2026">Real event page</a>';
    expect(pickPrimaryUrl("", html)).toBe("https://realfair.example.com/2026");
  });
});

describe("extractAllUrls — K1 host denylist (multi-URL fan-out)", () => {
  it("excludes denylisted hosts from the multi-URL output", () => {
    const text =
      "Three events:\n" +
      "https://us.list-manage.com/track/abc\n" +
      "https://winthroparts.org/aug-15\n" +
      "https://bit.ly/x\n" +
      "https://otherfair.example.com/sep-3";
    const out = extractAllUrls(text, "", 10);
    expect(out).toEqual(["https://winthroparts.org/aug-15", "https://otherfair.example.com/sep-3"]);
  });

  it("returns an empty list when only denylisted URLs are present", () => {
    const text = "https://us.list-manage.com/track/a\nhttps://t.co/b\nhttps://mailchi.mp/c";
    expect(extractAllUrls(text, "", 10)).toEqual([]);
  });
});

// buildReply tests moved to __tests__/email-reply-builder.test.ts after
// the multi-intent refactor — that file owns the templates now and the
// signature changed from (ctx) to (kind, to, params).
