/**
 * OPE-576 — a Workers AI timeout must not throw away a page the deterministic
 * salvage could have read.
 *
 * ── What the ticket asked first, and the answer ────────────────────────────
 * "When the 20s ceiling trips, does the operator see an explicit error, an
 * empty result, or a fabricated/partial event? Do not optimize the timeout
 * before answering this."
 *
 * It fails CLOSED, and always did: `{success:false, events:[], confidence:{}}`
 * plus an operator-visible message. No event record, no model-authored prose.
 * The fabrication hypothesis is not what is wrong here. The last test in this
 * file pins that, so it cannot regress.
 *
 * ── The real defect ────────────────────────────────────────────────────────
 * The K7 deterministic salvage (name + (date OR venue), zero AI cost) lived
 * inside the same `try` as the AI call, gated on `events.length === 0`. A
 * timeout THROWS, so it unwound straight past the one fallback built for
 * exactly this case: a page that timed out returned nothing even when its OG
 * title and a month-day-range heading were sitting in the content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const extractMultipleEvents = vi.fn();

vi.mock("@/lib/url-import/ai-extractor", () => ({
  extractMultipleEvents: (...args: unknown[]) => extractMultipleEvents(...args),
}));

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareAi: () => ({ run: vi.fn() }),
  getCloudflareDb: () => ({}),
}));

const logged: { level?: string; message?: string; context?: Record<string, unknown> }[] = [];
// NOTE the signature: the main app's `logError` is `logError(db, options)` —
// the DB comes FIRST. A one-arg mock silently captures the db instead and the
// assertion below fails against `[{}]`, which reads like "nothing was logged".
vi.mock("@/lib/logger", () => ({
  logError: async (
    _db: unknown,
    entry: { level?: string; message?: string; context?: Record<string, unknown> }
  ) => {
    logged.push(entry);
  },
}));

// The route is wrapped in `withAuthorized`; run the handler directly with a
// stub db so the test exercises extraction rather than auth.
vi.mock("@/lib/api/with-auth", () => ({
  withAuthorized:
    (handler: (ctx: { request: Request; db: unknown }) => Promise<Response>) =>
    (request: Request) =>
      handler({ request, db: {} }),
}));

const { POST } = await import("../route");

/** A page the deterministic composer CAN read: a title and a date range. */
const SALVAGEABLE_CONTENT =
  "Warner Fall Foliage Festival\nJoin us in Warner, NH.\nOCTOBER 10-11, 2026\nFree admission.";

/** A page with nothing to lift — no date, no usable heading. */
const UNSALVAGEABLE_CONTENT = "Thanks for visiting. Check back soon for details.";

/**
 * Call the handler. The real `withAuthorized` wrapper takes (request, context);
 * the mock above ignores the second, but the cast has to satisfy the wrapper's
 * declared arity or `tsc` fails the build while vitest passes.
 */
function post(body: Record<string, unknown>) {
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request("https://meetmeatthefair.com/api/admin/import-url/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {}
  );
}

beforeEach(() => {
  extractMultipleEvents.mockReset();
  logged.length = 0;
});

describe("AI timeout → deterministic salvage", () => {
  it("SALVAGES a readable page instead of returning nothing — the defect", async () => {
    extractMultipleEvents.mockRejectedValue(
      new Error("Workers AI multi-event extraction timed out after 20000ms")
    );

    const res = await post({
      content: SALVAGEABLE_CONTENT,
      url: "https://example.org/warner",
      metadata: { title: "Warner Fall Foliage Festival" },
    });
    const body = (await res.json()) as {
      success: boolean;
      events: unknown[];
      extractionMethod?: string;
      aiFailure?: string;
    };

    expect(body.success).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.extractionMethod).toBe("thin");
    // The reason is carried so a comparing caller can tell a deterministic
    // guess from a real reading (see the holdout-sampler guard).
    expect(body.aiFailure).toContain("timed out");
  });

  it("instruments the failure — the 24 prod rows carried `context: {}`", async () => {
    extractMultipleEvents.mockRejectedValue(new Error("timed out after 20000ms"));
    await post({
      content: SALVAGEABLE_CONTENT,
      metadata: { title: "Warner Fall Foliage Festival" },
    });

    const entry = logged.find((l) => l.message?.includes("deterministic salvage"));
    expect(entry).toBeDefined();
    // Without these the ceiling could only ever be tuned by guess.
    expect(entry?.context?.contentLength).toBe(SALVAGEABLE_CONTENT.length);
    expect(typeof entry?.context?.elapsedMs).toBe("number");
    // A rescued page is not a failure.
    expect(entry?.level).toBe("warn");
  });

  it("FAILS CLOSED when salvage finds nothing — no event, no prose", async () => {
    extractMultipleEvents.mockRejectedValue(new Error("timed out after 20000ms"));

    const res = await post({ content: UNSALVAGEABLE_CONTENT });
    const body = (await res.json()) as {
      success: boolean;
      events: unknown[];
      confidence: Record<string, unknown>;
      error?: string;
    };

    expect(body.success).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.confidence).toEqual({});
    expect(body.error).toBeTruthy();
    // The burst was 9 sequential cron calls, not an operator — but if a human
    // does hit this, the message should stop them retrying a dead page.
    expect(body.error).toMatch(/unlikely to help|manually/i);
  });

  it("does not disturb the ordinary success path", async () => {
    extractMultipleEvents.mockResolvedValue({
      events: [{ name: "Real Event", _extractId: "ai-1" }],
      confidence: { "ai-1": { name: "high" } },
    });

    const res = await post({ content: SALVAGEABLE_CONTENT });
    const body = (await res.json()) as { success: boolean; extractionMethod?: string };
    expect(body.success).toBe(true);
    expect(body.extractionMethod).toBe("ai");
  });

  it("still salvages when the AI SUCCEEDS but returns zero events — K7's original path", async () => {
    extractMultipleEvents.mockResolvedValue({ events: [], confidence: {} });

    const res = await post({
      content: SALVAGEABLE_CONTENT,
      metadata: { title: "Warner Fall Foliage Festival" },
    });
    const body = (await res.json()) as { extractionMethod?: string; aiFailure?: string };
    expect(body.extractionMethod).toBe("thin");
    // No AI failure here — the model answered, it just found nothing.
    expect(body.aiFailure).toBeUndefined();
  });
});
