/**
 * OPE-68 — inbound-email attachment OCR → event pipeline.
 *
 * Drives InboundEmailWorkflow.runSubmitPipeline end-to-end with:
 *   - a mocked `env.AI.toMarkdown` (the OCR — real conversion is validated
 *     live post-deploy),
 *   - a mocked `env.VENDOR_ASSETS` R2 bucket (returns the stored poster bytes),
 *   - the four main-app submit-leg endpoints stubbed via a shared-state fetch
 *     (same harness shape as inbound-email-multi-source.test.ts).
 *
 * Proves:
 *   1. An OCR'd poster (attachment source) creates a PENDING event, threads the
 *      attachment signal (attachmentEventsCreated), and best-effort sets the
 *      poster as the event hero (upload-image-bytes POST fires).
 *   2. The same event in the body AND the poster collapses to ONE event
 *      (sequential DB-backed dedup).
 *   3. A poster that OCRs to trivial/empty markdown yields NO attachment source
 *      and never crashes — the flow falls through to the normal no-url reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlug } from "@takemetothefair/utils";
import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

interface RowSnapshot {
  parsedUrl: string | null;
  fromAddress: string;
  subject: string;
  attachmentCount: number;
  attachmentRefs: string | null;
  classifiedSubIntent: string | null;
  bodyTextExcerpt: string | null;
}

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

interface AiConfig {
  /** markdown text env.AI.toMarkdown returns for every attachment. */
  markdown?: string;
  /** when true, VENDOR_ASSETS.get returns null (object missing). */
  missingObject?: boolean;
}

function makeWorkflow(ai: AiConfig) {
  const toMarkdownCalls: string[] = [];
  const AI = {
    toMarkdown: vi.fn(async (files: Array<{ name: string; blob: Blob }>) => {
      toMarkdownCalls.push(files[0]?.name ?? "");
      return files.map((f, i) => ({
        id: String(i),
        name: f.name,
        mimeType: "text/markdown",
        format: "markdown" as const,
        tokens: 5,
        data: ai.markdown ?? "",
      }));
    }),
  };
  const VENDOR_ASSETS = {
    get: vi.fn(async (_key: string) => {
      if (ai.missingObject) return null;
      const buf = new Uint8Array([1, 2, 3, 4]).buffer;
      return {
        blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
        arrayBuffer: async () => buf,
        httpMetadata: { contentType: "image/png" },
      };
    }),
  };
  const env = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "test-key",
    EMAIL: undefined,
    AI,
    VENDOR_ASSETS,
  };
  const wf = new (InboundEmailWorkflow as unknown as new (
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
  return { wf, toMarkdownCalls, AI, VENDOR_ASSETS };
}

const norm = (s: string) => s.trim().toLowerCase();
const slugify = (s: string): string => createSlug(s);

interface FetchConfig {
  bodyEvents?: Array<Record<string, unknown>>;
}

/** Stub the four submit-leg endpoints + the poster-hero upload endpoint. */
function installFetch(cfg: FetchConfig) {
  const created: string[] = [];
  const createdKeys = new Set<string>();
  const submitBodies: Array<Record<string, unknown>> = [];
  const heroUploads: Array<{ targetId: string }> = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const path = u.pathname;

    // Poster-as-hero upload (multipart FormData body — not JSON).
    if (path === "/api/admin/upload-image-bytes") {
      const form = init?.body as FormData;
      const targetId = typeof form?.get === "function" ? String(form.get("target_id") ?? "") : "";
      heroUploads.push({ targetId });
      return Response.json({ success: true, image_url: "https://cdn.test/events/x/poster.webp" });
    }

    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (path === "/api/admin/import-url/extract") {
      // Attachment + body sources both use submitFreeTextExtract (no `url`).
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
  return { created, submitBodies, heroUploads };
}

const ref = (mimeType: string) =>
  JSON.stringify([{ key: "inbound-attachments/g/0-poster", name: "poster", mimeType, size: 10 }]);

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-68 attachment OCR → pipeline", () => {
  it("creates a PENDING event from an OCR'd poster and sets the hero + signal", async () => {
    const row: RowSnapshot = {
      parsedUrl: null,
      fromAddress: "alice@example.com",
      subject: "See attached",
      attachmentCount: 1,
      attachmentRefs: ref("image/png"),
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: "see attached", // < 20 chars → no body source
    };
    const { created, heroUploads } = installFetch({
      bodyEvents: [{ name: "Flyer Fest", startDate: "2026-07-04", venueName: "City Park" }],
    });
    const { wf, toMarkdownCalls } = makeWorkflow({
      markdown: "Flyer Fest happening July 4 2026 at City Park — vendors welcome!",
    });
    const { step, labels } = makeStep(row);

    const result = await wf.runSubmitPipeline(step, "row-1");

    // OCR ran; a single candidate collapses to the rich single-event reply.
    expect(toMarkdownCalls).toHaveLength(1);
    expect(labels).toContain("ocr-attachments");
    expect(created).toEqual(["Flyer Fest"]);
    expect(result.replyKind).toBe("ok");
    // Attachment signal threaded for the outcome-aware reply copy.
    expect(result.replyParams?.attachmentEventsCreated).toBe(1);
    expect(result.replyParams?.attachmentsRead).toBe(true);
    // Best-effort poster-as-hero fired against the created event.
    expect(heroUploads).toHaveLength(1);
    expect(heroUploads[0].targetId).toBe("e-flyer-fest");
    expect(labels).toContain("submit/poster-hero");
  });

  it("dedups the poster event against the SAME event in the body → 1 event", async () => {
    const row: RowSnapshot = {
      parsedUrl: null,
      fromAddress: "alice@example.com",
      subject: "Spring Fair",
      attachmentCount: 1,
      attachmentRefs: ref("image/png"),
      classifiedSubIntent: "new_event",
      // > 20 chars with a real event → body pseudo-source is created too.
      bodyTextExcerpt:
        "Spring Fair is May 5 2026 at the Town Green. Details on the attached poster!",
    };
    // Both the body source and the attachment source extract the SAME event.
    const { created, submitBodies } = installFetch({
      bodyEvents: [{ name: "Spring Fair", startDate: "2026-05-05", venueName: "Town Green" }],
    });
    const { wf } = makeWorkflow({ markdown: "Spring Fair May 5 2026 Town Green" });
    const { step } = makeStep(row);

    const result = await wf.runSubmitPipeline(step, "row-1");

    // One created; the second source dedups against the now-existing row.
    expect(created).toEqual(["Spring Fair"]);
    expect(submitBodies).toHaveLength(1);
    expect(result.replyKind).toBe("ok-multi");
    expect(String(result.replyParams?.resultsText)).toContain("already in our directory");
  });

  it("a poster that OCRs to empty markdown yields no source and no crash (falls to no-url)", async () => {
    const row: RowSnapshot = {
      parsedUrl: null,
      fromAddress: "alice@example.com",
      subject: "Poster",
      attachmentCount: 1,
      attachmentRefs: ref("image/png"),
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: "hi", // no body substance
    };
    const { created } = installFetch({ bodyEvents: [] });
    const { wf, toMarkdownCalls } = makeWorkflow({ markdown: "   " }); // trivial → below MIN_OCR_CHARS
    const { step, labels } = makeStep(row);

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(toMarkdownCalls).toHaveLength(1); // OCR attempted
    expect(created).toEqual([]); // nothing created
    expect(result.replyKind).toBe("no-url"); // graceful fall-through
    expect(labels).toContain("ocr-attachments");
  });

  it("a missing R2 object yields no attachment source and no crash", async () => {
    const row: RowSnapshot = {
      parsedUrl: null,
      fromAddress: "alice@example.com",
      subject: "Poster",
      attachmentCount: 1,
      attachmentRefs: ref("image/png"),
      classifiedSubIntent: "new_event",
      bodyTextExcerpt: "hi",
    };
    const { created } = installFetch({ bodyEvents: [] });
    const { wf } = makeWorkflow({ markdown: "whatever", missingObject: true });
    const { step } = makeStep(row);

    const result = await wf.runSubmitPipeline(step, "row-1");

    expect(created).toEqual([]);
    expect(result.replyKind).toBe("no-url");
  });
});
