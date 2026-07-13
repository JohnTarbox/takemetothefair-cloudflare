/**
 * OPE-55 Phase 1 — unified multi-source fan-out.
 *
 * The InboundEmailWorkflow submit pipeline used to branch mutually-
 * exclusively: a URL present dropped the body text; multi_url dropped
 * free-text; etc. These tests drive `runSubmitPipeline` end-to-end (with
 * the `submit/load-row` DB read stubbed via the step mock and every leg's
 * `fetch` mocked) to prove:
 *
 *   1. N distinct events across body + URLs → N events created.
 *   2. The SAME event in body AND a URL → 1 event (sequential DB-backed
 *      dedup collapses the second).
 *   3. Existing single-URL-only and body-text-only submissions behave
 *      exactly as before (fast paths untouched — no fan-out engaged).
 *   4. A per-source failure isolates to that source; the others create.
 *
 * The workflow step orchestration is simulated by a `step.do` mock that
 * runs each step body inline (no retry/timeout semantics needed for unit
 * scope) and short-circuits `submit/load-row` to a synthetic row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlug } from "@takemetothefair/utils";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

interface RowSnapshot {
  parsedUrl: string | null;
  fromAddress: string;
  subject: string;
  attachmentCount: number;
  classifiedSubIntent: string | null;
  bodyTextExcerpt: string | null;
}

/** step.do mock: returns the synthetic row for `submit/load-row`, else
 *  executes the (last-arg) step body inline. Records every label. */
function makeStep(row: RowSnapshot) {
  const labels: string[] = [];
  const step = {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      labels.push(label);
      if (label === "submit/load-row") return row;
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return await fn();
    },
  };
  return { step, labels };
}

function makeWorkflow() {
  const env = {
    DB: {} as unknown as D1Database, // logError swallows write failures
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "test-key",
    EMAIL: undefined,
  };
  // WorkflowEntrypoint(ctx, env) — ctx unused by runSubmitPipeline.
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
      status: string;
      resultingEventId?: string | null;
    }>;
  })({}, env);
}

const norm = (s: string) => s.trim().toLowerCase();
const slugify = (s: string): string => createSlug(s);

interface FetchConfig {
  /** target-url → events[] the /extract endpoint returns for that URL. */
  urlEvents?: Record<string, Array<Record<string, unknown>>>;
  /** events[] the /extract endpoint returns for a free-text (no-url) call. */
  bodyEvents?: Array<Record<string, unknown>>;
  /** substrings of a fetch target that should return a 500 (fetch-failed). */
  failFetch?: string[];
}

/**
 * Install a global fetch that emulates the four main-app endpoints the
 * submit legs call, backed by a shared `created` set so a submit becomes
 * visible to the NEXT check-duplicate call (the DB round-trip that gives
 * cross-source dedup).
 */
function installFetch(cfg: FetchConfig) {
  const created: string[] = []; // event names created this run
  const createdKeys = new Set<string>();
  const submitBodies: Array<Record<string, unknown>> = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const path = u.pathname;
    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (path === "/api/admin/import-url/fetch") {
      const target = u.searchParams.get("url") ?? "";
      if ((cfg.failFetch ?? []).some((s) => target.includes(s))) {
        return new Response("upstream down", { status: 500 });
      }
      return Response.json({
        success: true,
        content: `CONTENT_FOR:${target}`,
        fetchMethod: "standard",
      });
    }

    if (path === "/api/admin/import-url/extract") {
      // submitExtract sends `url`; submitFreeTextExtract does NOT.
      if (typeof body.url === "string" && body.url.length > 0) {
        const events = cfg.urlEvents?.[body.url] ?? [];
        return Response.json({
          success: true,
          events,
          count: events.length,
          extractionMethod: "ai",
        });
      }
      const events = cfg.bodyEvents ?? [];
      return Response.json({ success: true, events, count: events.length });
    }

    if (path === "/api/suggest-event/check-duplicate") {
      const name = typeof body.name === "string" ? body.name : "";
      if (name && createdKeys.has(norm(name))) {
        return Response.json({
          success: true,
          isDuplicate: true,
          matchType: "similar_name_date",
          existingEvent: { id: `e-${slugify(name)}`, slug: slugify(name), name, status: "PENDING" },
        });
      }
      return Response.json({ success: true, isDuplicate: false });
    }

    if (path === "/api/suggest-event/submit") {
      submitBodies.push(body);
      const name = typeof body.name === "string" ? body.name : "unnamed";
      created.push(name);
      createdKeys.add(norm(name));
      return Response.json({
        success: true,
        event: { id: `e-${slugify(name)}`, slug: slugify(name) },
      });
    }

    throw new Error(`unexpected fetch to ${path}`);
  };

  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
  return { created, submitBodies };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // The workflow's best-effort telemetry / seed-discovery / logError steps
  // write to `env.DB`, which is a bare stub here (they're wrapped in their
  // own try/catch and swallow failures by design). Silence the expected
  // console noise so the suite output stays readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-55 multi-source fan-out", () => {
  it("creates N events for N DISTINCT events across body + URL", async () => {
    // Body mentions a distinct event AND links a URL describing another.
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/a",
      fromAddress: "alice@example.com",
      subject: "Two events",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt:
        "Please add Riverside Fair happening June 1 2026 at Riverside Park. " +
        "Our other event is at https://ex.test/a — thanks!",
    };
    const { created, submitBodies } = installFetch({
      urlEvents: { "https://ex.test/a": [{ name: "Downtown Fair", startDate: "2026-05-05" }] },
      bodyEvents: [
        { name: "Riverside Fair", startDate: "2026-06-01", venueName: "Riverside Park" },
      ],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(result.replyKind).toBe("ok-multi");
    expect(created.sort()).toEqual(["Downtown Fair", "Riverside Fair"]);
    expect(submitBodies).toHaveLength(2);
    expect(result.replyParams?.eventCount).toBe(2);
    // URL source ran first (URL-first ordering) then the body pseudo-source.
    expect(labels).toContain("submit/multi[0]/fetch-url");
    expect(labels).toContain("submit/multi[0]/ai-extract");
    expect(labels).toContain("submit/bodytext/extract");
    // URL event kept its provenance; body event did not send a sourceUrl.
    const urlSubmit = submitBodies.find((b) => b.name === "Downtown Fair");
    const bodySubmit = submitBodies.find((b) => b.name === "Riverside Fair");
    expect(urlSubmit?.sourceUrl).toBe("https://ex.test/a");
    expect(bodySubmit?.sourceUrl).toBeUndefined();
  });

  it("creates only 1 event when the SAME event is in body AND a URL (sequential dedup)", async () => {
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/a",
      fromAddress: "alice@example.com",
      subject: "Spring Fair",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt:
        "Spring Fair is May 5 2026 at Town Green. Full details at https://ex.test/a. Thanks!",
    };
    // Both the URL and the body describe the SAME event name.
    const { created, submitBodies } = installFetch({
      urlEvents: { "https://ex.test/a": [{ name: "Spring Fair", startDate: "2026-05-05" }] },
      bodyEvents: [{ name: "Spring Fair", startDate: "2026-05-05", venueName: "Town Green" }],
    });
    const { step } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    // URL created first; body candidate dedups against the now-existing row.
    expect(created).toEqual(["Spring Fair"]);
    expect(submitBodies).toHaveLength(1);
    expect(result.replyKind).toBe("ok-multi");
    // One created bullet + one already-exists bullet.
    expect(result.replyParams?.eventCount).toBe(2);
    expect(String(result.replyParams?.resultsText)).toContain("already in our directory");
  });

  it("isolates a per-source failure — the other sources still create", async () => {
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/bad",
      fromAddress: "alice@example.com",
      subject: "Fairs",
      attachmentCount: 0,
      classifiedSubIntent: "multi_url",
      bodyTextExcerpt:
        "Two listings: https://ex.test/bad and https://ex.test/good — please add both, thank you!",
    };
    const { created, submitBodies } = installFetch({
      failFetch: ["/bad"],
      urlEvents: { "https://ex.test/good": [{ name: "Good Fair", startDate: "2026-07-10" }] },
      bodyEvents: [], // the accompanying prose has no event of its own
    });
    const { step } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(created).toEqual(["Good Fair"]);
    expect(submitBodies).toHaveLength(1);
    expect(result.replyKind).toBe("ok-multi");
    expect(String(result.replyParams?.resultsText)).toContain("Couldn't fetch https://ex.test/bad");
    expect(String(result.replyParams?.resultsText)).toContain('"Good Fair"');
  });

  it("collapses to the single-event reply when only ONE candidate survives (common URL + polite body)", async () => {
    // The body is a >20-char pleasantry with a link but no event of its own.
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/a",
      fromAddress: "alice@example.com",
      subject: "Please add my event",
      attachmentCount: 0,
      classifiedSubIntent: "new_event",
      bodyTextExcerpt:
        "Hi there! Could you please add my event to your wonderful calendar? Link: https://ex.test/a. Thank you so much!",
    };
    const { created, submitBodies } = installFetch({
      urlEvents: { "https://ex.test/a": [{ name: "Town Fair", startDate: "2026-08-01" }] },
      bodyEvents: [], // pleasantry → no event
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    // Exactly one event, and the RICH single-event reply (not ok-multi),
    // routed through submitExtractedEvent's tail (seed-discovery ran).
    expect(created).toEqual(["Town Fair"]);
    expect(submitBodies).toHaveLength(1);
    expect(result.replyKind).toBe("ok");
    expect(labels).toContain("submit/seed-discovery");
    expect(labels).toContain("submit/submit-event");
  });
});

describe("OPE-55 backward-compat — single-source fast paths unchanged", () => {
  it("single-URL-only submission does NOT engage the multi-source path", async () => {
    // No usable body text → no body pseudo-source → 1 source → fall-through
    // single-URL path, identical to pre-OPE-55.
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/a",
      fromAddress: "alice@example.com",
      subject: "My event",
      attachmentCount: 0,
      classifiedSubIntent: "single_url",
      bodyTextExcerpt: "",
    };
    const { created, submitBodies } = installFetch({
      urlEvents: { "https://ex.test/a": [{ name: "Solo Fair", startDate: "2026-09-01" }] },
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(result.replyKind).toBe("ok");
    expect(created).toEqual(["Solo Fair"]);
    expect(submitBodies).toHaveLength(1);
    // The single-URL fast path uses the flat labels, NOT the fan-out ones.
    expect(labels).toContain("submit/fetch-url");
    expect(labels.some((l) => l.startsWith("submit/multi["))).toBe(false);
    expect(labels).not.toContain("submit/bodytext/extract");
  });

  it("free_text body-only submission stays on the B2 free-text path", async () => {
    const row: RowSnapshot = {
      parsedUrl: null,
      fromAddress: "alice@example.com",
      subject: "Event details",
      attachmentCount: 0,
      classifiedSubIntent: "free_text",
      bodyTextExcerpt:
        "Autumn Market is October 12 2026 at the Village Commons. Hope you can list it!",
    };
    const { created, submitBodies } = installFetch({
      bodyEvents: [
        { name: "Autumn Market", startDate: "2026-10-12", venueName: "Village Commons" },
      ],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    // OPE-185 — a body-prose draft now gets the distinct ok-low-body-extract reply
    // ("we drafted this from your message"), not the URL/attachment `ok`.
    expect(result.replyKind).toBe("ok-low-body-extract");
    expect(created).toEqual(["Autumn Market"]);
    expect(submitBodies).toHaveLength(1);
    // B2 uses the fixed free-text label; the fan-out labels never appear.
    expect(labels).toContain("submit/free-text-extract");
    expect(labels.some((l) => l.startsWith("submit/multi["))).toBe(false);
    expect(labels).not.toContain("submit/bodytext/extract");
  });

  it("free_text override: a signature URL in the body does NOT trigger a fetch", async () => {
    // GH #244 — classifier said free_text; even though the body contains a
    // link, we must NOT fan out and fetch it. Body-only path wins.
    const row: RowSnapshot = {
      parsedUrl: "https://ex.test/signature",
      fromAddress: "alice@example.com",
      subject: "Event",
      attachmentCount: 0,
      classifiedSubIntent: "free_text",
      bodyTextExcerpt:
        "Winter Fest is December 6 2026 at the Grange Hall. Sent from https://ex.test/signature",
    };
    const { created } = installFetch({
      // If the pipeline wrongly fetched the signature URL it would 500.
      failFetch: ["/signature"],
      bodyEvents: [{ name: "Winter Fest", startDate: "2026-12-06", venueName: "Grange Hall" }],
    });
    const { step, labels } = makeStep(row);
    const wf = makeWorkflow();

    const result = await wf.runSubmitPipeline(step, "row-1");

    // OPE-185 — body-prose draft → ok-low-body-extract (was `ok`).
    expect(result.replyKind).toBe("ok-low-body-extract");
    expect(created).toEqual(["Winter Fest"]);
    expect(labels.some((l) => l.startsWith("submit/multi["))).toBe(false);
  });
});
