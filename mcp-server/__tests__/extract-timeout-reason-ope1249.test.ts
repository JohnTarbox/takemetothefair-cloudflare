/**
 * OPE-1249 — c8f9d623 (Harvest on the Harbor): the link fetched fine (8127
 * chars), Workers AI timed out in the extract route, salvage found nothing, and
 * the row was recorded `no-fetchable-url` with reply `no-url` (downgraded at
 * send by the OPE-453 invariant). Driven through the real fan-out pipeline with
 * the main-app endpoints emulated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

const URL_A = "https://share.google/abc123";
const row = {
  parsedUrl: URL_A,
  fromAddress: "submitter@example.com",
  subject: "Harvest on the Harbor returns to Portland for its 18th year",
  attachmentCount: 0,
  classifiedSubIntent: "new_event",
  bodyTextExcerpt:
    "Harvest on the Harbor returns to Portland for its 18th year this fall, " +
    `with tastings and chef demos along the waterfront. ${URL_A}`,
};

function makeStep() {
  return {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      if (label === "submit/load-row") return row;
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return await fn();
    },
  };
}

function makeWorkflow() {
  const env = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "test-key",
    EMAIL: undefined,
  };
  return new (InboundEmailWorkflow as unknown as new (
    ctx: unknown,
    env: unknown
  ) => {
    runSubmitPipeline: (
      step: unknown,
      id: string
    ) => Promise<{
      replyKind: string | null;
      replyParams?: Record<string, unknown>;
      extractFailReason?: string;
    }>;
  })({}, env);
}

/** fetchOk: does /fetch succeed. extract: what /extract returns for the URL. */
function installFetch(opts: { fetchOk: boolean; urlExtract: Record<string, unknown> }) {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (u.pathname === "/api/admin/import-url/fetch") {
      if (!opts.fetchOk) return new Response("upstream down", { status: 500 });
      return Response.json({
        success: true,
        content: "x".repeat(8127),
        title: "Harvest on the Harbor",
        fetchMethod: "standard",
      });
    }
    if (u.pathname === "/api/admin/import-url/extract") {
      if (typeof body.url === "string" && body.url) return Response.json(opts.urlExtract);
      return Response.json({ success: true, events: [], count: 0 }); // body prose: nothing usable
    }
    if (u.pathname === "/api/suggest-event/check-duplicate")
      return Response.json({ success: true, isDuplicate: false });
    throw new Error(`unexpected fetch to ${u.pathname}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
}

const AI_TIMEOUT_FAIL_CLOSED = {
  success: false,
  events: [],
  confidence: {},
  error:
    "Could not extract event data from this page — the extractor timed out and no usable title or date could be recovered. Retrying is unlikely to help; please add the event manually.",
  aiFailure: "Workers AI multi-event extraction timed out after 20000ms",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-1249 — a post-fetch extraction failure is not a fetch failure", () => {
  it("fetch OK + AI timeout → ai-timeout, unfetchable-url chosen directly (no invariant downgrade)", async () => {
    installFetch({ fetchOk: true, urlExtract: AI_TIMEOUT_FAIL_CLOSED });
    const r = await makeWorkflow().runSubmitPipeline(makeStep(), "c8f9d623");
    expect(r.extractFailReason).toBe("ai-timeout");
    expect(r.replyKind).toBe("unfetchable-url");
    expect(r.replyParams?.attemptedUrl).toBe(URL_A);
  });

  it("fetch OK + extractor returns zero events → zero-events, not no-fetchable-url", async () => {
    installFetch({ fetchOk: true, urlExtract: { success: true, events: [], count: 0 } });
    const r = await makeWorkflow().runSubmitPipeline(makeStep(), "x");
    expect(r.extractFailReason).toBe("zero-events");
    expect(r.replyKind).toBe("unfetchable-url");
  });

  it("control: a genuinely unfetchable URL still records no-fetchable-url", async () => {
    installFetch({ fetchOk: false, urlExtract: AI_TIMEOUT_FAIL_CLOSED });
    const r = await makeWorkflow().runSubmitPipeline(makeStep(), "y");
    expect(r.extractFailReason).toBe("no-fetchable-url");
    expect(r.replyKind).toBe("unfetchable-url");
  });
});
