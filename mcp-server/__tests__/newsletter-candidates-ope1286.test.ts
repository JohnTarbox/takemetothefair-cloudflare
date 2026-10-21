/**
 * OPE-1286 — the newsletter lane switch-over: an `unmatched` newsletter item
 * becomes a PENDING candidate, and a newsletter the lane owns no longer runs
 * the submit pipeline.
 *
 * The step logic is exercised against the real test database with the main-app
 * calls (dedup relay, submit route) faked at the dependency seam, because those
 * are HTTP hops to the other deploy artifact. The workflow wiring is asserted at
 * source level, as the other workflow tests in this folder are, anchored on call
 * and branch syntax rather than bare symbols (a bare symbol matches the import).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  candidateSourceUrl,
  createCandidate,
  createNewsletterCandidates,
  newsletterLaneOwns,
  type CandidateDeps,
} from "../src/inbound/newsletter-candidates.js";
import type { DisposedItem } from "../src/inbound/newsletter-dispose.js";
import type { NewsletterItemsRecord } from "../src/inbound/newsletter-process.js";
import { submitCheckDuplicate } from "../src/email-handlers/submit.js";
import {
  eventDataCitations,
  events,
  inboundEmails,
  inboundNewsletters,
  promoters,
  workflowRunSteps,
} from "../src/schema.js";

/** Joyce's Craft Shows' issue shape (prod a482d86b, 2026-10-10), with a third
 *  show that has its year printed and is not one of ours. */
const BODY = `Joyce's Craft Shows — fall schedule

1) *October 17-18 - **Sat 10-5/Sun 10-4* - *Schouler Park, 1 Norcross Circle, North Conway
*2) Oct 31-Nov 1 - Sat 10-4/Sun 10-3* -*Tanger, 120 Laconia Rd., Tilton
3) Christmas in the Valley Craft Fair - December 5-6, 2026 - Kennett High School, North Conway

Unsubscribe <https://joycescraftshows.us.list-manage.com/unsubscribe>`;

const UNMATCHED: DisposedItem = {
  name: "Christmas in the Valley Craft Fair",
  startDate: "2026-12-05",
  endDate: "2026-12-06",
  venue: "Kennett High School",
  city: "North Conway",
  state: "NH",
  excerpt: "Christmas in the Valley Craft Fair - December 5-6, 2026 - Kennett High School",
  yearExplicit: true,
  disposition: { kind: "unmatched", promoterId: "cff0a829" },
};
const MATCHED: DisposedItem = {
  name: "Leaf Peeper's Craft Fair",
  startDate: "2026-10-17",
  endDate: "2026-10-18",
  venue: "Schouler Park",
  city: "North Conway",
  state: "NH",
  excerpt: "1) *October 17-18 - **Sat 10-5/Sun 10-4* - *Schouler Park",
  yearExplicit: false,
  disposition: { kind: "matched", eventId: "430ba7d6", matchType: "venue_date", citedFields: [] },
};

const ctx = {
  promoterId: "cff0a829",
  sourceUrl: "https://joycescraftshows.com/",
  bodyText: BODY,
  inboundEmailId: "ie-a482d86b",
};

function fakeDeps(over: Partial<CandidateDeps> = {}) {
  const calls = {
    checkDuplicate: [] as Parameters<CandidateDeps["checkDuplicate"]>[0][],
    submit: [] as Parameters<CandidateDeps["submit"]>[],
    refusals: [] as string[],
    citations: [] as Parameters<CandidateDeps["writeCitations"]>[0][],
  };
  const deps: CandidateDeps = {
    checkDuplicate: async (x) => {
      calls.checkDuplicate.push(x);
      return { isDuplicate: false };
    },
    submit: async (x, c) => {
      calls.submit.push([x, c]);
      return { id: "new-event-1", slug: "x", eventName: x.event.name, routed: "created" };
    },
    recordRefusal: async (_x, reason) => {
      calls.refusals.push(reason);
    },
    writeCitations: async (a) => {
      calls.citations.push(a);
      return a.fields.length;
    },
    ...over,
  };
  return { deps, calls };
}

describe("who the lane owns", () => {
  it("an attributed newsletter, or one a trusted submitter forwarded — nothing else", () => {
    expect(newsletterLaneOwns({ isNewsletter: true, promoterId: "p1" }, "unknown")).toBe(true);
    expect(newsletterLaneOwns({ isNewsletter: true, promoterId: null }, "trusted")).toBe(true);
    expect(newsletterLaneOwns({ isNewsletter: true, promoterId: null }, "unknown")).toBe(false);
    expect(newsletterLaneOwns({ isNewsletter: true, promoterId: null }, "watchlist")).toBe(false);
    expect(newsletterLaneOwns({ isNewsletter: false, promoterId: "p1" }, "trusted")).toBe(false);
  });

  it("source_url is the promoter's website, never a tracker host or a non-http value", () => {
    expect(candidateSourceUrl("https://joycescraftshows.com/")).toBe(
      "https://joycescraftshows.com/"
    );
    expect(candidateSourceUrl("https://joyce.us.list-manage.com/track/click?u=1")).toBe("");
    expect(candidateSourceUrl("https://r20.rs6.net/tn.jsp?f=1")).toBe("");
    expect(candidateSourceUrl("javascript:alert(1)")).toBe("");
    expect(candidateSourceUrl("joycescraftshows.com")).toBe("");
    expect(candidateSourceUrl(null)).toBe("");
  });
});

describe("createCandidate — one unmatched item, through the submit lane's chokepoints", () => {
  it("ACCEPTANCE: creates through submitEvent with the attributed promoter, and cites the excerpt", async () => {
    const { deps, calls } = fakeDeps();
    const out = await createCandidate(UNMATCHED, ctx, deps);
    expect(out).toEqual({
      outcome: "created",
      eventId: "new-event-1",
      routed: "created",
      possibleDuplicateOf: null,
      citedFields: ["start_date", "end_date"],
    });
    expect(calls.submit).toHaveLength(1);
    const [extracted, sctx] = calls.submit[0];
    expect(extracted.url).toBe("https://joycescraftshows.com/");
    expect(extracted.event).toMatchObject({
      name: "Christmas in the Valley Craft Fair",
      startDate: "2026-12-05",
      endDate: "2026-12-06",
      venueName: "Kennett High School",
      venueCity: "North Conway",
      venueState: "NH",
    });
    expect(sctx).toMatchObject({
      inboundEmailId: "ie-a482d86b",
      promoterId: "cff0a829",
      dedupWasBlind: false,
      sourceTexts: [BODY],
    });
    expect(calls.citations[0]).toMatchObject({
      eventId: "new-event-1",
      excerpt: UNMATCHED.excerpt,
    });
  });

  it("dedup compares the ITEM, never the promoter's homepage", async () => {
    const { deps, calls } = fakeDeps();
    await createCandidate(UNMATCHED, ctx, deps);
    expect(calls.checkDuplicate).toHaveLength(1);
    // landmark: the check DID see the item
    expect(calls.checkDuplicate[0].event.name).toBe("Christmas in the Valley Craft Fair");
    expect(calls.checkDuplicate[0].url).toBe("");
  });

  it("OPE-450: a prior human adjudication is HIGH — no row, and the keeper is named", async () => {
    const { deps, calls } = fakeDeps({
      checkDuplicate: async () => ({
        isDuplicate: true,
        matchType: "prior_adjudication",
        existingEventId: "keeper-1",
        existingEventSlug: "keeper",
      }),
    });
    expect(await createCandidate(UNMATCHED, ctx, deps)).toEqual({
      outcome: "exists",
      eventId: "keeper-1",
      matchType: "prior_adjudication",
    });
    expect(calls.submit).toHaveLength(0);
  });

  it("a MEDIUM match still creates, tagged possible_duplicate_of (the submit lane's rule)", async () => {
    const { deps, calls } = fakeDeps({
      checkDuplicate: async () => ({
        isDuplicate: true,
        matchType: "similar_name_date",
        existingEventId: "maybe-1",
        existingEventSlug: "maybe",
      }),
    });
    const out = await createCandidate(UNMATCHED, ctx, deps);
    expect(out).toMatchObject({ outcome: "created", possibleDuplicateOf: "maybe-1" });
    expect(calls.submit[0][1].possibleDuplicateOf).toBe("maybe-1");
  });

  it("a blind dedup is passed through so submitEvent flags the row (OPE-804)", async () => {
    const { deps, calls } = fakeDeps({
      checkDuplicate: async () => ({ isDuplicate: false, dedupWasBlind: true }),
    });
    await createCandidate(UNMATCHED, ctx, deps);
    expect(calls.submit[0][1].dedupWasBlind).toBe(true);
  });

  it("the OPE-1253 floor refuses a link label before dedup or submit runs", async () => {
    const { deps, calls } = fakeDeps();
    const junk = { ...UNMATCHED, name: "Follow us on Facebook" };
    expect(await createCandidate(junk, ctx, deps)).toEqual({
      outcome: "refused",
      reason: "non-event-name",
    });
    expect(calls.refusals).toEqual(["non-event-name"]);
    expect(calls.checkDuplicate).toHaveLength(0);
    expect(calls.submit).toHaveLength(0);
  });

  it("a submit failure is an outcome on the item, never a throw", async () => {
    const { deps } = fakeDeps({
      submit: async () => {
        throw new Error("submit-503: upstream");
      },
    });
    expect(await createCandidate(UNMATCHED, ctx, deps)).toEqual({
      outcome: "failed",
      error: "submit-503: upstream",
    });
  });

  it("an edition that already exists under its series creates nothing and cites nothing", async () => {
    const { deps, calls } = fakeDeps({
      submit: async (x) => ({
        id: "series-ed",
        slug: "",
        eventName: x.event.name,
        routed: "occurrence_exists",
      }),
    });
    expect(await createCandidate(UNMATCHED, ctx, deps)).toEqual({
      outcome: "occurrence-exists",
      eventId: "series-ed",
    });
    expect(calls.citations).toHaveLength(0);
  });
});

describe("createNewsletterCandidates — the newsletter/candidates step", () => {
  let db: TestDb;
  const record = (items: DisposedItem[]): NewsletterItemsRecord => ({
    version: "nl-itemize-2026-10-02-v1",
    proposed: items.length,
    items,
    dropped: [],
  });

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(promoters)
      .values({
        id: "cff0a829",
        companyName: "Joyce's Craft Shows",
        slug: unsafeSlug("joyces-craft-shows"),
        website: "https://joycescraftshows.com/",
      })
      .run();
    db.insert(inboundEmails)
      .values({
        id: "ie-a482d86b",
        receivedAt: new Date("2026-10-10T19:30:00Z"),
        createdAt: new Date("2026-10-10T19:30:00Z"),
        fromAddress: "joyceendee@joycescraftshows.com",
        toAddress: "submit@meetmeatthefair.com",
        bodyText: BODY,
        originalSenderAuth: "verified",
        intent: "submit",
        status: "received",
        attachmentCount: 0,
      } as never)
      .run();
    db.insert(inboundNewsletters)
      .values({
        inboundEmailId: "ie-a482d86b",
        markers: "esp:sendibm,bulk:unsubscribe",
        promoterId: "cff0a829",
        matchBasis: "sender-domain",
        senderAddress: "joyceendee@joycescraftshows.com",
        itemsJson: JSON.stringify(record([MATCHED, UNMATCHED])),
        createdAt: new Date(),
      })
      .run();
    db.insert(events)
      .values({
        id: "new-event-1",
        name: "Christmas in the Valley Craft Fair",
        slug: unsafeSlug("christmas-in-the-valley-craft-fair"),
        promoterId: "cff0a829",
        status: "PENDING",
        createdAt: new Date(),
      })
      .run();
  });

  const stored = () =>
    JSON.parse(
      db.select().from(inboundNewsletters).all()[0].itemsJson ?? "{}"
    ) as NewsletterItemsRecord;

  it("ACCEPTANCE: exactly one candidate for the one unmatched item; the matched item is untouched", async () => {
    const submit = vi.fn(async (x: { event: { name: string } }) => ({
      id: "new-event-1",
      slug: "x",
      eventName: x.event.name,
      routed: "created" as const,
    }));
    const r = await createNewsletterCandidates(db as never, {} as never, "ie-a482d86b", "wf-1", {
      checkDuplicate: async () => ({ isDuplicate: false }),
      submit,
    });
    expect(r).toEqual({ status: "ok", counts: { unmatched: 1, created: 1 } });
    expect(submit).toHaveBeenCalledTimes(1);
    const [extracted, sctx] = submit.mock.calls[0] as unknown as [
      { url: string },
      { promoterId: string },
    ];
    expect(sctx.promoterId).toBe("cff0a829");
    expect(extracted.url).toBe("https://joycescraftshows.com/");

    const items = stored().items;
    expect(items[0].disposition).toEqual(MATCHED.disposition);
    expect(items[1].disposition).toMatchObject({
      kind: "unmatched",
      candidate: { outcome: "created", eventId: "new-event-1" },
    });

    // The real citation writer: the excerpt, this email's source key, the
    // verified-sender cap.
    const cites = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.eventId, "new-event-1"))
      .all();
    expect(cites.map((c) => [c.fieldName, c.value]).sort()).toEqual([
      ["end_date", "2026-12-06"],
      ["start_date", "2026-12-05"],
    ]);
    expect(cites[0].sourceUrl).toBe(
      "email://joyceendee@joycescraftshows.com/newsletter/ie-a482d86b"
    );
    expect(cites[0].confidence).toBe(0.6);

    const steps = db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.stepName, "newsletter/candidates"))
      .all();
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("ok");
    expect(JSON.parse(steps[0].detail ?? "{}")).toMatchObject({
      items: 2,
      unmatched: 1,
      created: 1,
    });
  });

  it("a retry never creates twice: an item carrying an outcome is skipped", async () => {
    const submit = vi.fn(async () => ({
      id: "new-event-1",
      slug: "x",
      eventName: "x",
      routed: "created" as const,
    }));
    const deps = { checkDuplicate: async () => ({ isDuplicate: false }), submit };
    await createNewsletterCandidates(db as never, {} as never, "ie-a482d86b", "wf-1", deps);
    const again = await createNewsletterCandidates(
      db as never,
      {} as never,
      "ie-a482d86b",
      "wf-2",
      deps
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(again.counts).toEqual({ unmatched: 1, alreadyDone: 1 });
  });

  it("a newsletter not yet itemized is skipped and says so", async () => {
    db.update(inboundNewsletters).set({ itemsJson: null }).run();
    const submit = vi.fn();
    const r = await createNewsletterCandidates(db as never, {} as never, "ie-a482d86b", "wf-1", {
      submit,
    });
    expect(r.status).toBe("skipped");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the shared dedup relay sends sourceUrl only when there is one", () => {
  it('the free-text / newsletter `url: ""` no longer 400s the check (schema is z.string().url())', async () => {
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, isDuplicate: false }), { status: 200 });
    }) as typeof fetch;
    try {
      const env = { MAIN_APP_URL: "https://app", INTERNAL_API_KEY: "k" } as never;
      const event = { name: "A Fair", startDate: "2026-12-05" };
      const base = {
        event,
        extractionMethod: "free-text" as const,
        totalEventsDetected: 1,
        additionalEventNames: [],
        events: [event],
      };
      await submitCheckDuplicate(env, { ...base, url: "" });
      await submitCheckDuplicate(env, { ...base, url: "https://x.example/e" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("sourceUrl");
    expect(bodies[0]).toMatchObject({ name: "A Fair", startDate: "2026-12-05" });
    expect(bodies[1].sourceUrl).toBe("https://x.example/e");
  });
});

describe("the workflow switch-over (source-level)", () => {
  const WF = readFileSync(`${__dirname}/../src/workflows/inbound-email.ts`, "utf8");
  const classify = WF.indexOf('"newsletter/classify",');
  const laneBranch = WF.indexOf(
    '} else if (newsletterLane && (intent === "submit" || intent === "new_event")) {'
  );
  const submitPipeline = WF.indexOf(
    "result = await this.runSubmitPipeline(step, messageRowId, sessionId);"
  );

  it("landmarks exist", () => {
    expect(classify).toBeGreaterThan(-1);
    expect(laneBranch).toBeGreaterThan(-1);
    expect(submitPipeline).toBeGreaterThan(-1);
  });

  it("classify runs BEFORE dispatch, and the lane branch is taken instead of the submit pipeline", () => {
    expect(classify).toBeLessThan(laneBranch);
    expect(laneBranch).toBeLessThan(submitPipeline);
    const branch = WF.slice(laneBranch, submitPipeline);
    // the lane branch sets no reply and does not call the pipeline itself
    expect(branch).toContain('routedToWorkflow = "newsletter-lane";');
    expect(branch).toContain('result = { replyKind: null, status: "replied" };');
    expect(branch.split("runSubmitPipeline(").length - 1).toBe(0);
  });

  it("candidates run after itemize, only when the lane owns the email", () => {
    const itemize = WF.indexOf('"newsletter/itemize",');
    const candidates = WF.indexOf('"newsletter/candidates",');
    expect(itemize).toBeGreaterThan(laneBranch);
    expect(candidates).toBeGreaterThan(itemize);
    expect(WF.slice(itemize, candidates)).toContain(
      'if (newsletterLane && itemized !== "failed") {'
    );
  });

  it("the flag keys on the candidates step's own verdict, not on itemize having run", () => {
    // An itemize that SKIPPED for want of a body or a model must read as not
    // done: the submit pipeline did not run either.
    expect(WF).toContain('laneDone = made.status === "ok" && !made.counts.failed;');
    const flag = WF.indexOf('"newsletter/lane-failed-flag",');
    expect(WF.slice(WF.lastIndexOf("if (newsletterLane) {", flag), flag)).toMatch(
      /^if \(newsletterLane\) \{\s*if \(!laneDone\) \{/
    );
  });

  it("classify, now ahead of dispatch, fails OPEN to the old path (not a newsletter)", () => {
    const at = WF.indexOf('"newsletter/classify",');
    const before = WF.slice(WF.lastIndexOf("let newsletter:", at), at);
    expect(before).toMatch(/isNewsletter: false,\s*basis: null,\s*promoterId: null,/);
    expect(before).toMatch(/try \{\s*newsletter = await step\.do\(\s*$/);
  });

  it("a failed lane flags the row: the submit pipeline did not run, so it must not drop silently", () => {
    const flag = WF.indexOf('"newsletter/lane-failed-flag",');
    expect(flag).toBeGreaterThan(WF.indexOf('"newsletter/candidates",'));
    expect(WF.slice(flag, flag + 600)).toContain("flaggedForReview: 1");
  });
});
