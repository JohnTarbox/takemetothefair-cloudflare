/**
 * OPE-1615 — a classifier timeout is retried, not decided.
 *
 * John's ruling (2026-11-10): no ack, intent or lane until a real verdict; one
 * reply only; a spam-screened neutral fallback after the last retry. These
 * tests drive the pieces that carry each acceptance item:
 *
 *  - `runClassifyRetries` / `routeRetriedClassification` — the loop and the
 *    route it settles on (acceptance 1, 2, 5).
 *  - `shouldDeferClassification` — the entrypoint's decision to defer at all.
 *  - `isZeroConfidenceUnclear` — the narrowed guard (acceptance 4).
 *  - the stale sweep — a retried row must not be re-run while its workflow is
 *    still live, which would be the second send acceptance 1–2 forbid.
 *  - the reply builder — the fallback sends the approved support-ack copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyIntent, type AiBinding, type ClassifierResult } from "../src/intent-classifier.js";
import {
  CLASSIFY_RETRY_DELAYS_SEC,
  CLASSIFY_RETRY_WINDOW_SEC,
  fallbackScreensOut,
  routeRetriedClassification,
  runClassifyRetries,
  shouldDeferClassification,
} from "../src/inbound/classify-retry.js";
import { isZeroConfidenceUnclear } from "../src/email-handlers/automated-mail.js";
import { buildReply } from "../src/email-reply-builder.js";
import { createTestDb, type TestDb } from "./setup-db.js";
import type { EmailIntent } from "../src/email-intents.js";

const INPUT = {
  toAddress: "hello@meetmeatthefair.com",
  fromAddress: "organizer@example.org",
  senderTrustTier: "unknown" as const,
  isReplyToOurThread: false,
  attachmentCount: 0,
  attachmentTypes: [] as string[],
  subject: "How do we list our events?",
  bodyText: "Hi — we run a monthly craft fair. How do we get our shows listed on your site?",
};

function verdict(
  intent: string,
  confidence: number,
  rationale = "model said so"
): ClassifierResult {
  return {
    intents: [
      {
        intent: intent as never,
        subIntent: null,
        confidence,
        rationale,
        refUrl: null,
        refEventClue: null,
      },
    ],
    version: "test",
    fromAi: true,
    startedAt: 0,
    finishedAt: 1,
    attempts: 1,
  };
}

function errored(message = "intent-classifier-timeout"): ClassifierResult {
  return {
    intents: [
      {
        intent: "unclear",
        subIntent: null,
        confidence: 0,
        rationale: `classifier-error: ${message}`,
        refUrl: null,
        refEventClue: null,
      },
    ],
    version: "test",
    fromAi: false,
    startedAt: 0,
    finishedAt: 1,
    attempts: 2,
  };
}

describe("runClassifyRetries (acceptance 1 and 2)", () => {
  it("a failure on attempt 1 then a verdict on attempt 2 settles once, on that verdict", async () => {
    const sleeps: number[] = [];
    const classify = vi
      .fn<(n: number) => Promise<ClassifierResult>>()
      .mockResolvedValueOnce(errored())
      .mockResolvedValueOnce(verdict("correction", 0.93));
    const out = await runClassifyRetries({
      addressIntent: "support",
      sleep: async (_n, s) => {
        sleeps.push(s);
      },
      classify,
    });
    expect(out.outcome).toBe("recovered");
    if (out.outcome !== "recovered") return;
    expect(out.attempt).toBe(2);
    expect(out.route.intent).toBe("correction");
    expect(out.route.routingSource).toBe("classifier_retry");
    // Exactly two classifications, and the loop stops: no third call.
    expect(classify).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([120, 480]);
  });

  it("all attempts failing is `exhausted` after exactly the documented schedule", async () => {
    const sleeps: number[] = [];
    const classify = vi.fn(async () => errored());
    const out = await runClassifyRetries({
      addressIntent: "support",
      sleep: async (_n, s) => {
        sleeps.push(s);
      },
      classify,
    });
    expect(out).toEqual({ outcome: "exhausted", attempts: 3 });
    expect(classify).toHaveBeenCalledTimes(3);
    // +2, +10, +30 minutes after arrival.
    expect(sleeps).toEqual([...CLASSIFY_RETRY_DELAYS_SEC]);
    expect(CLASSIFY_RETRY_WINDOW_SEC).toBe(30 * 60);
  });

  it("records every attempt, recovered or not", async () => {
    const seen: string[] = [];
    await runClassifyRetries({
      addressIntent: "support",
      sleep: async () => {},
      classify: vi
        .fn<(n: number) => Promise<ClassifierResult>>()
        .mockResolvedValueOnce(errored())
        .mockResolvedValueOnce(errored("network"))
        .mockResolvedValueOnce(verdict("press", 0.9)),
      onAttempt: async (n, r) => {
        seen.push(`${n}:${r.kind}`);
      },
    });
    expect(seen).toEqual(["1:error", "2:error", "3:routed"]);
  });
});

describe("routeRetriedClassification", () => {
  it("a confident spam verdict routes to the spam handler (no reply)", () => {
    const r = routeRetriedClassification(verdict("spam", 0.99), "support");
    expect(r).toMatchObject({ kind: "routed", intent: "spam" });
  });

  it("a below-threshold verdict falls back to the address, flagged, and the guard still applies", () => {
    const r = routeRetriedClassification(verdict("unclear", 0), "support");
    expect(r).toMatchObject({
      kind: "routed",
      intent: "support",
      routingSource: "fallback_low_confidence",
      flaggedForReview: true,
    });
    // The classifier RAN, so a zero-confidence unclear is still withheld.
    if (r.kind === "routed") {
      expect(isZeroConfidenceUnclear(r.classifiedIntent, r.confidence, r.rationale)).toBe(true);
    }
  });

  it("a multi-intent verdict dispatches its strongest child and says it collapsed", () => {
    const res: ClassifierResult = {
      ...verdict("support", 0.88),
      intents: [
        {
          intent: "support",
          subIntent: null,
          confidence: 0.88,
          rationale: "a",
          refUrl: null,
          refEventClue: null,
        },
        {
          intent: "correction",
          subIntent: null,
          confidence: 0.95,
          rationale: "b",
          refUrl: null,
          refEventClue: null,
        },
      ],
    };
    const r = routeRetriedClassification(res, "support");
    expect(r).toMatchObject({
      kind: "routed",
      intent: "correction",
      multiIntentCollapsed: true,
      flaggedForReview: true,
    });
  });

  it("another error is not a verdict", () => {
    expect(routeRetriedClassification(errored(), "support")).toEqual({ kind: "error" });
  });
});

describe("acceptance 5 — a simulated first-attempt failure routes on retry (no send)", () => {
  // The specimen 7f761f2a's body is not copied into the repo: it is a real
  // person's mail and John is handling her. The shape is reproduced: a
  // listing question to hello@, first model call failing, second answering.
  let calls = 0;
  const ai: AiBinding = {
    run: vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("AiError: 3040 capacity exceeded");
      return {
        response: JSON.stringify({
          intents: [
            {
              intent: "new_event",
              sub_intent: null,
              confidence: 0.91,
              rationale: "wants to list shows",
            },
          ],
        }),
      };
    }),
  };
  beforeEach(() => {
    calls = 0;
  });

  it("the first classifyIntent is an error that defers; the retry routes to the real lane", async () => {
    const first = await classifyIntent(ai, INPUT);
    expect(first.fromAi).toBe(false);
    expect(first.intents[0].rationale.startsWith("classifier-error:")).toBe(true);
    expect(
      shouldDeferClassification({
        routingSource: "address_only",
        aggregateRationale: first.intents[0].rationale,
        routed: [{}],
        spamQuarantine: false,
      })
    ).toBe(true);

    const out = await runClassifyRetries({
      addressIntent: "support",
      sleep: async () => {},
      classify: () => classifyIntent(ai, INPUT),
    });
    expect(out.outcome).toBe("recovered");
    if (out.outcome === "recovered") expect(out.route.intent).toBe("new_event");
  });
});

describe("shouldDeferClassification", () => {
  const base = { routed: [{}], spamQuarantine: false };
  it("defers only when the classifier ran and errored", () => {
    expect(
      shouldDeferClassification({
        ...base,
        routingSource: "address_only",
        aggregateRationale: "classifier-error: x",
      })
    ).toBe(true);
    // Answered at low confidence: a verdict, not deferred.
    expect(
      shouldDeferClassification({
        ...base,
        routingSource: "fallback_low_confidence",
        aggregateRationale: "meh",
      })
    ).toBe(false);
    // Classifier never invoked (no binding / fast-path): not deferred.
    expect(
      shouldDeferClassification({
        ...base,
        routingSource: "address_only",
        aggregateRationale: "no-ai-binding",
      })
    ).toBe(false);
    expect(
      shouldDeferClassification({
        ...base,
        spamQuarantine: true,
        routingSource: "address_only",
        aggregateRationale: "classifier-error: x",
      })
    ).toBe(false);
  });
});

describe("isZeroConfidenceUnclear — acceptance 4", () => {
  it("a classifier-error rationale no longer trips the guard", () => {
    expect(
      isZeroConfidenceUnclear("unclear", 0, "classifier-error: intent-classifier-timeout")
    ).toBe(false);
  });
  it("a completed zero-confidence unclear still does", () => {
    expect(isZeroConfidenceUnclear("unclear", 0, "nothing to go on")).toBe(true);
    expect(isZeroConfidenceUnclear("unclear", 0)).toBe(true);
  });
});

describe("fallback", () => {
  it("screens out a list-broker pitch and passes an ordinary question", () => {
    expect(
      fallbackScreensOut({
        subject: "Pre-Registered Attendee List",
        bodyText:
          "We're pleased to offer access to the Pre-Registered Attendee List at a discounted price. The list includes Contact Name, Verified Business Email Address.",
      })
    ).toBe(true);
    expect(fallbackScreensOut(INPUT)).toBe(false);
  });

  it("the neutral ack is the approved support-ack copy, verbatim", () => {
    const a = buildReply("ack-after-classifier-failure", "a@x.com", { subject: "hi" });
    const b = buildReply("support-ack", "a@x.com", { subject: "hi" });
    expect(a.text).toBe(b.text);
    expect(a.subject).toBe(b.subject);
  });
});

describe("stale sweep — a retried row is not re-run while live (no second send)", () => {
  let db: TestDb;
  let raw: ReturnType<typeof createTestDb>["raw"];
  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    raw = setup.raw;
  });
  afterEach(() => vi.restoreAllMocks());

  function insert(status: string, minutesAgo: number, replyKind: string | null): string {
    const id = crypto.randomUUID();
    const t = Math.floor(Date.now() / 1000) - minutesAgo * 60;
    raw
      .prepare(
        `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, status,
         workflow_instance_id, attachment_count, recovery_attempt_n, reply_kind, created_at)
         VALUES (?, ?, 'a@example.com', 'hello@meetmeatthefair.com', 'support', ?, 'wf-old', 0, 0, ?, ?)`
      )
      .run(id, t, status, replyKind, t);
    return id;
  }

  async function sweptIds(): Promise<string[]> {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const created: string[] = [];
    const env = {
      DB: raw as unknown as D1Database,
      INBOUND_EMAIL: {
        create: vi.fn(
          async ({ params }: { params: { messageRowId: string; intent: EmailIntent } }) => {
            created.push(params.messageRowId);
            return { id: `wf-new-${created.length}` };
          }
        ),
      } as unknown as Workflow<{ messageRowId: string; intent: EmailIntent }>,
    };
    await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      env
    );
    return created;
  }

  it("leaves a 40-minute-old row that resumed from a retry, and still sweeps an ordinary stalled one", async () => {
    const resumed = insert("processing", 40, "classify-retry:2");
    const waiting = insert("classifying", 40, "classify-retry:1");
    const ordinary = insert("processing", 40, null);
    const ids = await sweptIds();
    expect(ids).toContain(ordinary);
    expect(ids).not.toContain(resumed);
    expect(ids).not.toContain(waiting);
  });

  it("recovers retried rows once the whole retry window plus the normal threshold has passed", async () => {
    const resumed = insert("processing", 50, "classify-retry:3");
    const stranded = insert("classifying", 50, "classify-retry:1");
    const ids = await sweptIds();
    expect(ids).toEqual(expect.arrayContaining([resumed, stranded]));
  });
});
