/**
 * OPE-1591 — a submission whose only link is a shared Google AI answer.
 *
 * Specimen: inbound `07e7c5cb` (2026-10-29), subject "gardiner maine high school
 * craft fair", body only `https://share.google/aimode/24IOXQhqgJCSNLL4b`. It got
 * the generic "the site didn't let our reader in" reply, which was not the
 * reason. These pin the wiring (no fetch, text match still runs), the decision,
 * and John's approved text (2026-11-08, option 1, "as written").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAiAnswerLink, isNonSourceUrl } from "@takemetothefair/utils";

vi.mock("../src/workflow-run-log.js", () => ({
  recordWorkflowStep: vi.fn(async () => {}),
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

import { InboundEmailWorkflow } from "../src/workflows/inbound-email.js";
import {
  decideLinkReply,
  findPublicListedEventById,
  type ListedEvent,
} from "../src/email-handlers/link-reply.js";
import { buildReply } from "../src/email-reply-builder.js";
import { createTestDb, type TestDb } from "./setup-db.js";
import type { Db } from "../src/db.js";

const AI_LINK = "https://share.google/aimode/24IOXQhqgJCSNLL4b";
const SUBJECT = "gardiner maine high school craft fair";

const GAHS: ListedEvent = {
  id: "478682d3",
  slug: "gahs-interact-club-holiday-craft-fair-2026",
  name: "GAHS Interact Club Holiday Craft Fair 2026",
  startDate: new Date("2026-12-19T12:00:00Z"),
  endDate: new Date("2026-12-19T12:00:00Z"),
};

const NO_MATCH = { outcome: "no-candidate", matched: null, candidates: [], searched: ["gardiner"] };
const MATCHED = {
  outcome: "matched",
  matched: {
    id: GAHS.id,
    slug: GAHS.slug,
    name: GAHS.name,
    startDate: "2026-12-19",
    score: 1.5,
    nameContainment: 1,
    eligible: true,
    reasons: [],
  },
  candidates: [],
  searched: ["gardiner"],
};

function installFetch(extract?: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input.toString();
      calls.push(raw);
      if (new URL(raw).pathname === "/api/admin/import-url/extract" && extract) {
        return Response.json(extract);
      }
      return new Response("upstream down", { status: 500 });
    }) as typeof fetch
  );
  return calls;
}

function makeStep(row: Record<string, unknown>) {
  const labels: string[] = [];
  const snapshot = {
    parsedUrl: AI_LINK,
    fromAddress: "someone@example.com",
    subject: SUBJECT,
    attachmentCount: 0,
    classifiedSubIntent: "single_url",
    bodyTextExcerpt: AI_LINK,
    bodyText: AI_LINK,
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
  const wf = new (
    InboundEmailWorkflow as unknown as new (
      ctx: unknown,
      env: unknown
    ) => {
      runSubmitPipeline: (
        step: unknown,
        id: string,
        instanceId: string
      ) => Promise<{
        replyKind: string | null;
        replyParams?: Record<string, unknown>;
        status: string;
      }>;
    }
  )({}, env);
  return wf.runSubmitPipeline(step, "row-1", "inst-1");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  matchInputs.length = 0;
  nextMatch = NO_MATCH;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isAiAnswerLink", () => {
  it.each([
    AI_LINK,
    "http://www.share.google/aimode/abc",
    "https://www.google.com/search?q=gardiner+craft+fair&udm=50",
    "https://www.google.co.uk/search?udm=50&q=fair",
  ])("is an AI answer: %s", (url) => {
    expect(isAiAnswerLink(url)).toBe(true);
    // ...and therefore can never be stored as a citation or confirm a date.
    expect(isNonSourceUrl(url)).toBe(true);
  });

  it.each([
    "https://share.google/JAFhqhevUuDYKe2Eu",
    "https://share.google/aimodel-review",
    "https://www.google.com/search?q=fair&udm=14",
    "https://example.org/aimode/fair",
    "not a url",
    "",
  ])("is NOT an AI answer: %s", (url) => {
    expect(isAiAnswerLink(url)).toBe(false);
  });

  it("control: an ordinary share.google link is still not a non-source", () => {
    expect(isNonSourceUrl("https://share.google/JAFhqhevUuDYKe2Eu")).toBe(false);
  });
});

describe("the pipeline never fetches an AI answer link", () => {
  it("ACCEPTANCE: the specimen makes no fetch, still tries the text match, and has a URL for the reply", async () => {
    const calls = installFetch();
    const { step, labels } = makeStep({});

    const result = await runPipeline(step);

    expect(calls).toEqual([]);
    expect(labels.filter((l) => l.includes("fetch-url"))).toEqual([]);
    expect(labels).not.toContain("multi-source-fanout");
    expect(matchInputs).toEqual([
      { subject: SUBJECT, bodyText: AI_LINK, receivedAt: expect.any(Number) },
    ]);
    // Resolved to `ai-answer-link` at send, by decideLinkReply, on this link.
    expect(result.replyKind).toBe("unfetchable-url");
    expect(result.replyParams?.attemptedUrl).toBe(AI_LINK);
    expect(result.replyParams?.textMatchedEventId).toBeUndefined();
  });

  it("a text match travels to the send step as an id", async () => {
    installFetch();
    nextMatch = MATCHED;
    const { step } = makeStep({});

    const result = await runPipeline(step);

    expect(result.replyParams?.textMatchedEventId).toBe(GAHS.id);
  });

  it("finds the link in the body when parsed_url is empty", async () => {
    const calls = installFetch();
    const { step } = makeStep({ parsedUrl: null });

    const result = await runPipeline(step);

    expect(calls).toEqual([]);
    expect(result.replyKind).toBe("unfetchable-url");
    expect(result.replyParams?.attemptedUrl).toBe(AI_LINK);
  });

  it("prose beside the link is still extracted, and the link is not handed to any fetch", async () => {
    const prose =
      "The Gardiner Area High School Interact Club holds its Holiday Craft Fair on Saturday December 19th in the gym.";
    const calls = installFetch({ success: false, events: [], confidence: {}, error: "none" });
    const { step, labels } = makeStep({
      bodyText: `${prose}\n\n${AI_LINK}`,
      bodyTextExcerpt: `${prose}\n\n${AI_LINK}`,
    });

    await runPipeline(step);

    expect(labels).toContain("submit/free-text-extract");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => new URL(c).pathname === "/api/admin/import-url/extract")).toBe(true);
    expect(calls.some((c) => c.includes("share.google"))).toBe(false);
  });

  it("a real link beside it is still fetched, and the AI link is not", async () => {
    const real = "https://example.org/fair";
    const calls = installFetch();
    const { step, labels } = makeStep({
      parsedUrl: real,
      bodyText: `${real}\n${AI_LINK}`,
      bodyTextExcerpt: `${real}\n${AI_LINK}`,
    });

    const result = await runPipeline(step);

    expect(labels).toContain("submit/multi[0]/fetch-url");
    expect(labels).not.toContain("submit/multi[1]/fetch-url");
    expect(calls.some((c) => c.includes(encodeURIComponent("example.org")))).toBe(true);
    expect(calls.some((c) => c.includes("aimode"))).toBe(false);
    expect(result.replyParams?.attemptedUrl).toBe(real);
  });

  it("ACCEPTANCE: an ordinary share.google link still follows its redirect", async () => {
    const link = "https://share.google/JAFhqhevUuDYKe2Eu";
    installFetch();
    const { step, labels } = makeStep({
      parsedUrl: link,
      bodyText: link,
      bodyTextExcerpt: link,
    });

    await runPipeline(step);

    expect(labels).toContain("submit/multi[0]/fetch-url");
    expect(labels).toContain("submit/multi[0]/resolve-share-redirect");
  });
});

describe("decideLinkReply — the AI answer case", () => {
  const base = { subject: SUBJECT, attemptedUrl: AI_LINK };

  it("picks ai-answer-link even when a fetch outcome was recorded", () => {
    const d = decideLinkReply({
      link: AI_LINK,
      linkOutcome: "fetch-failed",
      listed: null,
      params: base,
    });
    expect(d.kind).toBe("ai-answer-link");
    expect(d.flagForReview).toBe(false);
  });

  it("wins over a stored source_url match: an AI link is never 'already listed'", () => {
    const d = decideLinkReply({
      link: AI_LINK,
      linkOutcome: undefined,
      listed: GAHS,
      params: base,
    });
    expect(d.kind).toBe("ai-answer-link");
  });

  it("control: a real link still gets reply C", () => {
    const d = decideLinkReply({
      link: "https://example.org/fair",
      linkOutcome: "fetch-failed",
      listed: null,
      textMatched: GAHS,
      params: base,
    });
    expect(d.kind).toBe("unfetchable-url");
  });
});

describe("the approved text", () => {
  const INTRO = "Thanks for emailing Meet Me at the Fair!";
  const WHY =
    "That link is a Google AI answer, so we can't see the organizer's page from it, and we don't use AI answers as a source.";
  const ASK =
    "If you can, reply with the organizer's own website or Facebook event, or just the event's name, dates and town in a line of text.";

  it("no text match: exactly the approved paragraphs, no 'may already list' line", () => {
    const d = decideLinkReply({
      link: AI_LINK,
      linkOutcome: undefined,
      listed: null,
      textMatched: null,
      params: { subject: SUBJECT },
    });
    const msg = buildReply(d.kind as "ai-answer-link", "a@example.com", d.params);
    expect(msg.text.startsWith(`${INTRO}\n\n${WHY}\n\n${ASK}\n\n`)).toBe(true);
    expect(msg.text).not.toContain("may already list");
    expect(msg.text).not.toContain("didn't let our reader in");
    expect(msg.source).toBe("email:ai-answer-link");
  });

  it("text match: names the event and its page after the first paragraph", () => {
    const d = decideLinkReply({
      link: AI_LINK,
      linkOutcome: undefined,
      listed: null,
      textMatched: GAHS,
      params: { subject: SUBJECT },
    });
    const msg = buildReply(d.kind as "ai-answer-link", "a@example.com", d.params);
    expect(
      msg.text.startsWith(
        `${INTRO}\n\nIt looks like we may already list this one: ${GAHS.name}\n  https://meetmeatthefair.com/events/${GAHS.slug}\n\n${WHY}\n\n${ASK}\n\n`
      )
    ).toBe(true);
  });

  it("OPE-771: a row holding a different link falls back to the couldn't-use-it reply", () => {
    const msg = buildReply("ai-answer-link", "a@example.com", {
      subject: SUBJECT,
      assertionFacts: { parsedUrl: "https://example.org/fair", bodyText: "see link" } as never,
    });
    expect(msg.source).toBe("email:unfetchable-url");
  });

  it("OPE-771 control: the real specimen keeps the approved reply", () => {
    const msg = buildReply("ai-answer-link", "a@example.com", {
      subject: SUBJECT,
      assertionFacts: { parsedUrl: AI_LINK, bodyText: AI_LINK } as never,
    });
    expect(msg.source).toBe("email:ai-answer-link");
  });
});

describe("findPublicListedEventById — the copy may only link a live page", () => {
  let db: TestDb;
  let raw: { exec: (s: string) => unknown };
  const start = Math.floor(new Date("2026-12-19T12:00:00Z").getTime() / 1000);
  const insert = (id: string, status: string, mergedInto: string | null = null) =>
    raw.exec(
      `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, lifecycle_status, merged_into)
       VALUES ('${id}', 'Fair ${id}', 'fair-${id}', 'p1', ${start}, ${start}, '${status}', 'SCHEDULED',
               ${mergedInto ? `'${mergedInto}'` : "NULL"})`
    );

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    raw = t.raw as unknown as typeof raw;
    raw.exec(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'P', 'p')`);
  });

  it("returns an approved event", async () => {
    insert("a", "APPROVED");
    expect((await findPublicListedEventById(db as unknown as Db, "a"))?.slug).toBe("fair-a");
  });

  it("refuses a PENDING row, which the text matcher can return", async () => {
    insert("b", "PENDING");
    expect(await findPublicListedEventById(db as unknown as Db, "b")).toBeNull();
  });

  it("refuses a merge tombstone and an unknown or absent id", async () => {
    insert("a", "APPROVED");
    insert("c", "APPROVED", "a");
    expect(await findPublicListedEventById(db as unknown as Db, "c")).toBeNull();
    expect(await findPublicListedEventById(db as unknown as Db, "nope")).toBeNull();
    expect(await findPublicListedEventById(db as unknown as Db, null)).toBeNull();
  });
});
