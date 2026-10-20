/**
 * OPE-1505 — the no-URL submit branch matches the email's TEXT against the
 * events we list, whatever the AI extraction does, and hands a match to
 * enrich-on-match.
 *
 * The specimen (inbound 01ad5525): a forwarded Grange craft fair notice, no
 * URL, and the extraction timed out — so before this, no match was ever
 * attempted and the run ended `no-url-prose-failed` about a fair we list. The
 * matcher itself is pinned in text-event-match-ope1505.test.ts; these pin the
 * WIRING: it runs, it is recorded, and a match reaches enrich-on-match even
 * when extraction fails. The body is invented prose in the specimen's shape.
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

const matchInputs: Array<{ subject: string | null; bodyText: string | null }> = [];
let nextMatch: unknown = null;
vi.mock("../src/inbound/text-event-match.js", () => ({
  matchEventFromText: vi.fn(
    async (_db: unknown, input: { subject: string | null; bodyText: string | null }) => {
      matchInputs.push(input);
      return nextMatch;
    }
  ),
}));

const staged: Array<Record<string, unknown>> = [];
vi.mock("../src/email-handlers/enrich-proposal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/email-handlers/enrich-proposal.js")>();
  return {
    ...real,
    stageEnrichOnMatch: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      staged.push(input);
      return { outcome: "nothing-staged", disposition: {}, flagged: false };
    }),
  };
});

import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";

const SUBJECT = "Fwd: Hillside Grange Harvest Craft Fair";
const BODY =
  "---------- Forwarded message ---------\n" +
  "From: Hillside Grange <grange@example.org>\n" +
  "Subject: Hillside Grange Harvest Craft Fair\n\n" +
  "Hello,\n\nThe Hillside Grange Harvest Craft Fair is Saturday October 24th.\n" +
  "There is a ramp at the back of the building, and the Lions Club will sell lunch.\n";

const ROUTE_TIMEOUT = {
  success: false,
  events: [],
  confidence: {},
  error: "Could not extract event data from this page — the extractor timed out",
  aiFailure: "Workers AI multi-event extraction timed out after 20000ms",
};

const MATCHED = {
  outcome: "matched",
  matched: {
    id: "ev-hillside",
    slug: "hillside",
    name: "Hillside Grange Harvest Craft Fair",
    startDate: "2026-10-24",
    score: 1.8,
    nameContainment: 1,
    eligible: true,
    reasons: ["name 100% (3 tokens)", "date 2026-10-24 named in text"],
  },
  candidates: [],
  searched: ["hillside", "grange", "harvest"],
};

function installFetch(extractReplies: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.pathname === "/api/admin/import-url/extract") {
        return Response.json(extractReplies.shift() ?? ROUTE_TIMEOUT);
      }
      throw new Error(`unexpected fetch to ${u.pathname}`);
    }) as typeof fetch
  );
}

function makeStep(row: Record<string, unknown> = {}) {
  const labels: string[] = [];
  const snapshot = {
    parsedUrl: null,
    fromAddress: "trusted@example.com",
    subject: SUBJECT,
    attachmentCount: 0,
    classifiedSubIntent: "free_text",
    bodyTextExcerpt: BODY.slice(0, 500),
    bodyText: BODY,
    ...row,
  };
  const step = {
    do: async (label: string, optsOrFn: unknown, maybeFn?: unknown) => {
      labels.push(label);
      if (label === "submit/load-row") return snapshot;
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

const textMatchRows = () => recorded.filter((r) => r.stepName === "submit/text-match");

beforeEach(() => {
  vi.unstubAllGlobals();
  recorded.length = 0;
  matchInputs.length = 0;
  staged.length = 0;
  nextMatch = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("OPE-1505 — the text match runs on a no-URL submission even when extraction fails", () => {
  it("ACCEPTANCE: extraction times out twice → the text match still runs, is recorded, and reaches enrich-on-match", async () => {
    installFetch([ROUTE_TIMEOUT, ROUTE_TIMEOUT]);
    nextMatch = MATCHED;
    const { step, labels } = makeStep();

    const result = await runPipeline(step);

    // The extraction really did fail (both attempts), and the reply is unchanged.
    expect(labels).toContain("submit/free-text-extract-retry");
    expect(result.replyKind).toBe("no-url-prose-failed");
    // The matcher saw the subject and the FULL body.
    expect(matchInputs).toEqual([
      { subject: SUBJECT, bodyText: BODY, receivedAt: expect.any(Number) },
    ]);
    // One recorded run, naming the match.
    expect(textMatchRows()).toHaveLength(1);
    expect(textMatchRows()[0]).toMatchObject({
      status: "ok",
      detail: { outcome: "matched", matched_event_id: "ev-hillside" },
    });
    // The match was handed to enrich-on-match, on its own path, and flagged.
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      existingEventId: "ev-hillside",
      path: "text-match",
      matchType: "text_match",
      inboundEmailId: "row-1",
    });
    expect(labels).toContain("submit/text-match-flag");
  });

  it("no match: the run is still recorded with its outcome and candidates, and nothing is staged", async () => {
    installFetch([ROUTE_TIMEOUT, ROUTE_TIMEOUT]);
    nextMatch = {
      outcome: "ambiguous",
      matched: null,
      candidates: [
        { id: "a", name: "A", startDate: null, score: 1, eligible: true, reasons: [] },
        { id: "b", name: "B", startDate: null, score: 0.9, eligible: true, reasons: [] },
      ],
      searched: ["grange"],
    };
    const { step } = makeStep();

    await runPipeline(step);

    expect(textMatchRows()).toHaveLength(1);
    expect(textMatchRows()[0]).toMatchObject({
      status: "ok",
      detail: { outcome: "ambiguous", matched_event_id: null },
    });
    expect((textMatchRows()[0].detail as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(staged).toHaveLength(0);
  });

  it("a matcher error is recorded as failed and never costs the sender a reply", async () => {
    installFetch([ROUTE_TIMEOUT, ROUTE_TIMEOUT]);
    const { matchEventFromText } = await import("../src/inbound/text-event-match.js");
    vi.mocked(matchEventFromText).mockRejectedValueOnce(new Error("D1 hiccup"));
    const { step } = makeStep();

    const result = await runPipeline(step);

    expect(result.replyKind).toBe("no-url-prose-failed");
    expect(textMatchRows()[0]).toMatchObject({ status: "failed", detail: { outcome: "error" } });
    expect(staged).toHaveLength(0);
  });

  it("a body that is not prose still gets a recorded text match (every no-URL submission)", async () => {
    installFetch([]);
    nextMatch = { outcome: "no-query", matched: null, candidates: [], searched: [] };
    const { step, labels } = makeStep({ bodyTextExcerpt: "", bodyText: "" });

    await runPipeline(step);

    expect(labels).not.toContain("submit/free-text-extract");
    expect(textMatchRows()).toHaveLength(1);
    expect(textMatchRows()[0].detail).toMatchObject({ outcome: "no-query" });
  });
});
