/**
 * OPE-1057 rework — the B2 free-text branch is countable, and a Workers AI
 * timeout gets one more attempt.
 *
 * The specimen (inbound 01ad5525, 2026-10-14): John forwarded a Grange craft
 * fair notice — Gmail `---------- Forwarded message ---------` preamble, a
 * subject, ~1,900 chars of prose, no URL, no attachment. The classifier labelled
 * it `free_text` (0.9), so it reached `submit/free-text-extract`; the extract
 * route then timed out at 20 s, the salvage found no name, and the run replied
 * `no-url-prose-failed` with NO record of the attempt — its `catch {}` was bare
 * and the step never wrote to `workflow_run_steps`. These tests pin:
 *
 *   1. every attempt writes one `submit/free-text-extract` row with its outcome;
 *   2. an AI timeout is retried once (`submit/free-text-extract-retry`), and a
 *      timeout-then-success drafts the event;
 *   3. a non-timeout failure is NOT retried;
 *   4. the trusted fast path (NULL sub-intent) reaches the same step;
 *   5. the extract call names its caller (`email-free-text`).
 *
 * The body below is invented prose in the specimen's SHAPE — not the real email.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded: Array<{ stepName: string; status: string; detail?: unknown }> = [];
vi.mock("../src/workflow-run-log.js", () => ({
  recordWorkflowStep: vi.fn(
    async (_db: unknown, rec: { stepName: string; status: string; detail?: unknown }) => {
      recorded.push({ stepName: rec.stepName, status: rec.status, detail: rec.detail });
    }
  ),
}));

import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

function futureDate(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const FAIR_DATE = futureDate(10);
const FORWARDED_BODY =
  "---------- Forwarded message ---------\n" +
  "From: Pat Example <pat@example.com>\n" +
  "Date: Wed, Oct 14, 2026 at 6:41 PM\n" +
  "Subject: Fwd: Hillside Grange Harvest Craft Fair\n" +
  "To: <john@example.com>\n\n\n\n\n" +
  "---------- Forwarded message ---------\n" +
  "From: Hillside Grange <hillsidegrange@example.org>\n" +
  "Date: Wed, Oct 14, 2026 at 4:08 PM\n" +
  "Subject: Hillside Grange Harvest Craft Fair\n" +
  "To: <vendor@example.net>\n\n\n" +
  "Hello,\n\n" +
  "The Hillside Grange Harvest Craft Fair is coming up soon and we are so glad\n" +
  "to have you with us as a vendor.\n\n" +
  `The fair is on Saturday ${FAIR_DATE} at Hillside Grange Hall, 12 Orchard Road.\n` +
  "Set-up is the evening before from 4-6pm and the morning of from 7-8am. The\n" +
  "fair runs from 8am to 2pm and clean-up is from 2-4pm.\n\n" +
  "We will supply a table and chairs; please bring your own table covering.\n" +
  "Coffee and snacks are free for vendors, and the Lions Club will sell lunch.\n\n" +
  "Thanks so much!\n\nBest,\n\nRobin\n";

const SUBJECT = "Fwd: Hillside Grange Harvest Craft Fair";

const FAIR_EVENT = {
  name: "Hillside Grange Harvest Craft Fair",
  startDate: FAIR_DATE,
  venueName: "Hillside Grange Hall",
};

/** What the extract route returns when Workers AI times out and the salvage fails. */
const ROUTE_TIMEOUT = {
  success: false,
  events: [],
  confidence: {},
  error: "Could not extract event data from this page — the extractor timed out",
  aiFailure: "Workers AI multi-event extraction timed out after 20000ms",
};

type ExtractReply = Record<string, unknown>;

function installFetch(extractReplies: ExtractReply[]) {
  const extractBodies: Array<Record<string, unknown>> = [];
  const created: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const body =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (u.pathname === "/api/admin/import-url/extract") {
      extractBodies.push(body);
      const reply = extractReplies.shift() ?? { success: true, events: [], count: 0 };
      return Response.json(reply);
    }
    if (u.pathname === "/api/suggest-event/check-duplicate") {
      return Response.json({ success: true, isDuplicate: false });
    }
    if (u.pathname === "/api/suggest-event/submit") {
      const name = String(body.name ?? "unnamed");
      created.push(name);
      return Response.json({ success: true, event: { id: "e-1", slug: "hillside" } });
    }
    throw new Error(`unexpected fetch to ${u.pathname}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
  return { extractBodies, created };
}

function makeStep(classifiedSubIntent: string | null, body: string = FORWARDED_BODY) {
  const labels: string[] = [];
  const row = {
    parsedUrl: null,
    fromAddress: "jtarboxme@gmail.com",
    subject: SUBJECT,
    attachmentCount: 0,
    classifiedSubIntent,
    bodyTextExcerpt: body.slice(0, 500),
    bodyText: body,
  };
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

function runPipeline(step: unknown) {
  const env = {
    DB: {} as unknown as D1Database,
    MAIN_APP_URL: "https://app.test",
    INTERNAL_API_KEY: "test-key",
    EMAIL: undefined,
  };
  const wf = new (InboundEmailWorkflow as unknown as new (
    ctx: unknown,
    env: unknown
  ) => {
    runSubmitPipeline: (
      step: unknown,
      id: string,
      instanceId: string
    ) => Promise<{ replyKind: string | null; status: string }>;
  })({}, env);
  return wf.runSubmitPipeline(step, "row-1", "inst-1");
}

const freeTextRows = () => recorded.filter((r) => r.stepName === "submit/free-text-extract");

beforeEach(() => {
  vi.unstubAllGlobals();
  recorded.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-1057 rework — a forwarded body-only event reaches free-text extract and is recorded", () => {
  it("classifier free_text (the 01ad5525 routing): extract runs, drafts, and writes one ok row", async () => {
    const { created, extractBodies } = installFetch([
      { success: true, events: [FAIR_EVENT], count: 1 },
    ]);
    const { step, labels } = makeStep("free_text");

    const result = await runPipeline(step);

    expect(labels).toContain("submit/free-text-extract");
    expect(result.replyKind).toBe("ok-low-body-extract");
    expect(created).toEqual([FAIR_EVENT.name]);
    expect(extractBodies[0].caller).toBe("email-free-text");
    const rows = freeTextRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].detail).toMatchObject({
      gate: "classifier_free_text",
      outcome: "drafted",
      attempts: 1,
    });
  });

  it("trusted fast path (NULL sub-intent): the same forward reaches the same step", async () => {
    const { created } = installFetch([{ success: true, events: [FAIR_EVENT], count: 1 }]);
    const { step, labels } = makeStep(null);

    const result = await runPipeline(step);

    expect(labels).toContain("submit/free-text-extract");
    expect(result.replyKind).toBe("ok-low-body-extract");
    expect(created).toEqual([FAIR_EVENT.name]);
    expect(freeTextRows()[0].detail).toMatchObject({
      gate: "classifier_skipped",
      outcome: "drafted",
    });
  });

  it("an AI timeout is retried once — timeout then success drafts the event", async () => {
    const { created, extractBodies } = installFetch([
      ROUTE_TIMEOUT,
      { success: true, events: [FAIR_EVENT], count: 1 },
    ]);
    const { step, labels } = makeStep("free_text");

    const result = await runPipeline(step);

    expect(labels).toContain("submit/free-text-extract-retry");
    expect(extractBodies).toHaveLength(2);
    expect(result.replyKind).toBe("ok-low-body-extract");
    expect(created).toEqual([FAIR_EVENT.name]);
    expect(freeTextRows()[0]).toMatchObject({
      status: "ok",
      detail: { outcome: "drafted", attempts: 2 },
    });
  });

  it("two timeouts: prose-failed reply, and the row says ai-timeout (the 01ad5525 outcome, now visible)", async () => {
    const { created, extractBodies } = installFetch([ROUTE_TIMEOUT, ROUTE_TIMEOUT]);
    const { step } = makeStep("free_text");

    const result = await runPipeline(step);

    expect(extractBodies).toHaveLength(2);
    expect(result.replyKind).toBe("no-url-prose-failed");
    expect(created).toEqual([]);
    const rows = freeTextRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].detail).toMatchObject({
      outcome: "extract-failed",
      attempts: 2,
      fail_reason: "ai-timeout",
    });
    expect((rows[0].detail as { error: string }).error).toMatch(/^extract-upstream: /);
  });

  it("zero events is NOT retried — a second draw cannot change it", async () => {
    const { extractBodies } = installFetch([{ success: true, events: [], count: 0 }]);
    const { step, labels } = makeStep("free_text");

    const result = await runPipeline(step);

    expect(labels).not.toContain("submit/free-text-extract-retry");
    expect(extractBodies).toHaveLength(1);
    expect(result.replyKind).toBe("no-url-prose-failed");
    expect(freeTextRows()[0].detail).toMatchObject({
      outcome: "extract-failed",
      attempts: 1,
      fail_reason: "zero-events",
    });
  });

  it("a declined gate (signature-only body) still writes one skipped row and never calls extract", async () => {
    const { extractBodies } = installFetch([{ success: true, events: [FAIR_EVENT], count: 1 }]);
    const { step, labels } = makeStep("free_text", "--\nJohn Tarbox\nSent from my iPhone");

    const result = await runPipeline(step);

    expect(labels).not.toContain("submit/free-text-extract");
    expect(extractBodies).toHaveLength(0);
    expect(result.replyKind).toBe("no-url");
    expect(freeTextRows()).toEqual([
      expect.objectContaining({
        status: "skipped",
        detail: expect.objectContaining({ reason: "no_prose_substance" }),
      }),
    ]);
  });

  it("an extraction without the minimum fields is recorded as insufficient-fields", async () => {
    installFetch([{ success: true, events: [{ name: "Hillside Grange" }], count: 1 }]);
    const { step } = makeStep("free_text");

    const result = await runPipeline(step);

    expect(result.replyKind).toBe("no-url-prose-failed");
    expect(freeTextRows()[0]).toMatchObject({
      status: "failed",
      detail: { outcome: "insufficient-fields", has_name: true, has_start_date: false },
    });
  });
});
