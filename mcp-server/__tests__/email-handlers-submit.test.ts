/**
 * Tests for the submit-intent leg functions. Each leg is now its own
 * workflow step; the throw shapes here drive the workflow's retry vs.
 * NonRetryable decision.
 *
 * Contract: 4xx / validation = NonRetryableError; 5xx / network = plain
 * Error. AI extract always throws NonRetryableError (audit doc finding).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import {
  submitFetch,
  submitExtract,
  submitCheckDuplicate,
  submitEvent,
  type SubmitFetchResult,
  type SubmitExtractResult,
} from "../src/email-handlers/submit.js";
import type { HandlerEnv } from "../src/email-handlers/types.js";

const ENV: HandlerEnv = {
  DB: {} as unknown as D1Database,
  MAIN_APP_URL: "https://example.com",
  INTERNAL_API_KEY: "test-key",
};

function mockFetch(impl: (input: RequestInfo | URL) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("submitFetch — retry contract", () => {
  it("returns parsed result on 2xx with success:true", async () => {
    mockFetch(() =>
      Response.json({
        success: true,
        content: "hello world",
        title: "T",
        description: "D",
        ogImage: null,
        jsonLd: { "@type": "Event" },
      })
    );
    const result = await submitFetch(ENV, "https://example.org");
    expect(result.url).toBe("https://example.org");
    expect(result.content).toBe("hello world");
    expect(result.title).toBe("T");
    expect(JSON.parse(result.jsonLdSerialized!)).toEqual({ "@type": "Event" });
  });

  it("throws NonRetryableError on 4xx (don't retry permanent failures)", async () => {
    mockFetch(() => new Response("bad url", { status: 400 }));
    await expect(submitFetch(ENV, "https://example.org")).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("throws plain Error on 5xx (retry transient failures)", async () => {
    mockFetch(() => new Response("upstream down", { status: 503 }));
    const err = await submitFetch(ENV, "https://example.org").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(err.message).toBe("fetch-503");
  });

  it("throws NonRetryableError when upstream reports {success:false}", async () => {
    mockFetch(() => Response.json({ success: false, error: "blocked by robots" }));
    const err = await submitFetch(ENV, "https://example.org").catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toContain("blocked by robots");
  });

  it("throws plain Error on network failure (retryable)", async () => {
    mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err = await submitFetch(ENV, "https://example.org").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });

  it("truncates oversized content to stay under step-output limit", async () => {
    const huge = "x".repeat(500_000);
    mockFetch(() => Response.json({ success: true, content: huge }));
    const result = await submitFetch(ENV, "https://example.org");
    expect(result.content.length).toBeLessThanOrEqual(100_000);
  });

  // Analyst C2 Phase 1 (2026-05-29): PDF detection at the fetch route
  // surfaces fetchMethod='pdf_unsupported' alongside a PDF-specific
  // userMessage. submitFetch routes this to a distinct `fetch-pdf:`
  // error prefix so the workflow's mark-done step can persist
  // fetch_method='pdf_unsupported' for analytics. Without the prefix
  // the row would be miscounted in the "both fetch paths failed"
  // cohort, which masks PDF as a real (and growing) ingestion shape.
  it("throws fetch-pdf prefix when upstream reports fetchMethod=pdf_unsupported", async () => {
    mockFetch(() =>
      Response.json({
        success: false,
        error:
          "This URL points to a PDF. We can't parse PDFs yet — please reply with the event details pasted as text.",
        fetchMethod: "pdf_unsupported",
      })
    );
    const err = await submitFetch(ENV, "https://example.org/application.pdf").catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toMatch(/^fetch-pdf:/);
    expect(err.message).toContain("PDF");
  });

  it("keeps generic fetch-upstream prefix when fetchMethod is absent/failed", async () => {
    // Regression guard: only fetchMethod==='pdf_unsupported' switches to
    // the fetch-pdf prefix. Generic upstream failures must stay on the
    // fetch-upstream branch so existing failure-mode counts don't shift.
    mockFetch(() => Response.json({ success: false, error: "blocked by robots" }));
    const err = await submitFetch(ENV, "https://example.org").catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toMatch(/^fetch-upstream:/);
  });
});

describe("submitExtract — retry contract", () => {
  const FETCHED: SubmitFetchResult = {
    url: "https://example.org",
    content: "hello",
    title: null,
    description: null,
    ogImage: null,
    jsonLdSerialized: null,
  };

  it("returns first event on success", async () => {
    mockFetch(() =>
      Response.json({
        success: true,
        events: [{ name: "Test Fair" }],
        count: 1,
      })
    );
    const result = await submitExtract(ENV, FETCHED);
    expect(result.event.name).toBe("Test Fair");
  });

  it("throws NonRetryableError on any failure mode (no retries — audit doc)", async () => {
    mockFetch(() => new Response("error", { status: 500 }));
    const err = await submitExtract(ENV, FETCHED).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
  });

  it("throws NonRetryableError when extracted events array is empty", async () => {
    mockFetch(() => Response.json({ success: true, events: [], count: 0 }));
    const err = await submitExtract(ENV, FETCHED).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
  });

  it("forwards parsed JSON-LD back as object (not string) to the extract API", async () => {
    // Capture the POST body so we can assert jsonLd was deserialized
    // back to a structured value (the step boundary stores it as a
    // string to dodge the recursive-Serializable type-instantiation).
    let captured: { metadata?: { jsonLd?: unknown } } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured =
          init && typeof init.body === "string"
            ? (JSON.parse(init.body) as { metadata?: { jsonLd?: unknown } })
            : null;
        return Response.json({ success: true, events: [{ name: "ok" }], count: 1 });
      })
    );
    await submitExtract(ENV, {
      ...FETCHED,
      jsonLdSerialized: JSON.stringify([{ "@type": "Event", name: "X" }]),
    });
    expect(captured).not.toBeNull();
    expect(captured!.metadata?.jsonLd).toEqual([{ "@type": "Event", name: "X" }]);
  });
});

describe("submitEvent — retry contract", () => {
  it("returns id + slug + eventName on 2xx success", async () => {
    mockFetch(() =>
      Response.json({ success: true, event: { id: "e-abc-123", slug: "my-fair-2026" } })
    );
    const result = await submitEvent(
      ENV,
      { url: "https://x", event: { name: "My Fair" } },
      "alice@example.com"
    );
    expect(result.id).toBe("e-abc-123");
    expect(result.slug).toBe("my-fair-2026");
    expect(result.eventName).toBe("My Fair");
  });

  it("throws NonRetryableError on 4xx", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ success: false, error: "validation" }), { status: 400 })
    );
    const err = await submitEvent(ENV, { url: "https://x", event: { name: "x" } }, "a@b.com").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(NonRetryableError);
  });

  it("throws plain Error on 5xx (retry transient failures)", async () => {
    mockFetch(() => new Response("oops", { status: 502 }));
    const err = await submitEvent(ENV, { url: "https://x", event: { name: "x" } }, "a@b.com").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });

  it("throws plain Error on network failure (retryable)", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const err = await submitEvent(ENV, { url: "https://x", event: { name: "x" } }, "a@b.com").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });
});

describe("submitCheckDuplicate — pre-submit dedup leg", () => {
  const EXTRACTED: SubmitExtractResult = {
    url: "https://example.org/event-page",
    event: { name: "Test Fair 2026", startDate: "2026-07-15" },
  };

  it("returns isDuplicate=false on a clean response", async () => {
    mockFetch(() => Response.json({ success: true, isDuplicate: false }));
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.isDuplicate).toBe(false);
  });

  it("returns isDuplicate=true with existing event info on exact_url match", async () => {
    mockFetch(() =>
      Response.json({
        success: true,
        isDuplicate: true,
        matchType: "exact_url",
        existingEvent: {
          id: "e-123",
          slug: "test-fair-2026",
          name: "Test Fair 2026",
          startDate: "2026-07-15T12:00:00Z",
          status: "APPROVED",
        },
      })
    );
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.isDuplicate).toBe(true);
    expect(r.matchType).toBe("exact_url");
    expect(r.existingEventId).toBe("e-123");
    expect(r.existingEventName).toBe("Test Fair 2026");
    expect(r.existingEventSlug).toBe("test-fair-2026");
  });

  it("returns isDuplicate=true with the similar_name_date match type", async () => {
    mockFetch(() =>
      Response.json({
        success: true,
        isDuplicate: true,
        matchType: "similar_name_date",
        similarity: 92,
        existingEvent: { id: "e-456", slug: "near-fest-xxxix", name: "NEAR-Fest XXXIX" },
      })
    );
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.matchType).toBe("similar_name_date");
  });

  it("fails open (isDuplicate=false) on dedup endpoint 5xx", async () => {
    mockFetch(() => new Response("internal error", { status: 500 }));
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.isDuplicate).toBe(false);
  });

  it("fails open on network error (transient dedup downtime)", async () => {
    mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.isDuplicate).toBe(false);
  });

  it("fails open on malformed JSON body", async () => {
    mockFetch(() => new Response("not json"));
    const r = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(r.isDuplicate).toBe(false);
  });

  it("omits name/startDate from the request body when extraction returned nulls", async () => {
    let captured: { sourceUrl?: string; name?: string; startDate?: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured =
          init && typeof init.body === "string"
            ? (JSON.parse(init.body) as { sourceUrl?: string; name?: string; startDate?: string })
            : null;
        return Response.json({ success: true, isDuplicate: false });
      })
    );
    await submitCheckDuplicate(ENV, {
      url: "https://example.org/event-page",
      event: { name: "" },
    });
    expect(captured).not.toBeNull();
    expect(captured!.sourceUrl).toBe("https://example.org/event-page");
    expect(captured!.name).toBeUndefined();
    expect(captured!.startDate).toBeUndefined();
  });
});
