/**
 * OPE-1285 — itemize a promoter newsletter and dispose of each dated item
 * against our events.
 *
 * Fixtures are the acceptance specimens' own text (prod D1, read 2026-10-02),
 * with tracker URLs shortened. Model responses are written the way the model
 * answers — including one it invents — because the model's output is the
 * untrusted input this code exists to check. Nothing here replays against prod.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  cleanNewsletterText,
  excerptStatesDate,
  groundItems,
  inferYear,
  parseItemsResponse,
  type RawItem,
} from "../src/inbound/newsletter-itemize.js";
import { disposeItems, type DisposeDeps } from "../src/inbound/newsletter-dispose.js";
import { processNewsletter } from "../src/inbound/newsletter-process.js";
import type { CheckDuplicateResult } from "../src/duplicates/check-duplicate.js";
import { NEVER_OUTREACH_DETECTORS } from "../src/goodwill/queue-ranking.js";
import {
  eventDataCitations,
  eventDiscrepancies,
  events,
  inboundEmails,
  inboundNewsletters,
  promoters,
  workflowRunSteps,
} from "../src/schema.js";

// ── Specimens ──────────────────────────────────────────────────────────────

/** 24c583d5 — Maine Lobster Festival, Mailchimp, received 2026-10-02. */
const MLF = `---------- Forwarded message ---------
From: Maine Lobster Festival <info@mainelobsterfestival.com>
Date: Thu, Oct 1, 2026 at 3:50 PM
Subject: Maine Lobster Festival Newsletter 🦞

View this email in your browser
<https://mailchi.mp/ae23881b7411/maine-lobster-festival>

Just in case you're already counting down the days until the 2027 Maine
Lobster Festival (we can't be the only ones), there are only 307 days left
to wait! Mark your calendar for the 80th Maine Lobster Festival, Aug. 4-8,
2027, at Harbor Park in Rockland, Maine!
<https://us.list-manage.com/HnqrIaRJ9Tj?e=b19cb15afd>

*Recent Donations*
The Maine Lobster Festival is more than a five-day event. This month, we gave
out two donations: $1,500 to Mid-Coast School of Technology
<https://us.list-manage.com/Na6vge8HKiN>'s Fire/EMS class.

*Thank You, Sponsors!*
A big thank you to our top sponsors: Dream Local Digital
<https://us.list-manage.com/Iq2ETMgSWvH>, Bangor Daily News.

Enjoy five days of fun and feasting at the 80th Maine Lobster Festival,
Aug. 4-8, 2027, at Harbor Park in Rockland, Maine.
Volunteer
<https://us.list-manage.com/rJVzo9PVfgi>
Schedule
<https://us.list-manage.com/m0bdri6J37s>
You are receiving this email because you expressed interest in the Maine
Lobster Festival.
You can update your preferences or unsubscribe from this list.`;

const MLF_MODEL: RawItem[] = [
  {
    name: "80th Maine Lobster Festival",
    start_date: "2027-08-04",
    end_date: "2027-08-08",
    venue: "Harbor Park",
    city: "Rockland",
    state: "ME",
    excerpt:
      "Mark your calendar for the 80th Maine Lobster Festival, Aug. 4-8, 2027, at Harbor Park in Rockland, Maine!",
  },
  // The second mention of the same event: deduplicated, not a second item.
  {
    name: "80th Maine Lobster Festival",
    start_date: "2027-08-04",
    end_date: "2027-08-08",
    excerpt: "the 80th Maine Lobster Festival, Aug. 4-8, 2027, at Harbor Park",
  },
  // Invented: the newsletter never says this.
  {
    name: "International Great Crate Race",
    start_date: "2027-08-07",
    end_date: null,
    excerpt: "The Great Crate Race returns Saturday, Aug. 7, 2027!",
  },
];

/** a14543b8 — New England Made "Meet the Maker", MailerLite, received 2026-08-17. */
const NEM = `---------- Forwarded message ---------
From: New England Made <whitney@greentreeevents.com>
Date: Mon, Aug 17, 2026 at 8:16 AM
Subject: NEM Meet the Maker: Studio 1119, Inc.💡

View in browser
<https://click.mlsend.com/link/c/YT0zMDc3>
We asked Studio 1119, Inc.... What are you most excited to showcase at NEM
this Fall?
Visit Studio 1119 at booth #409
<https://click.mlsend.com/link/c/YT0zMDc4>
SHOW DETAILS
<https://click.mlsend.com/link/c/YT0zMDc5>

*New England Made Autumn Show 2026*

*When? *September 15-16, 2026

*Where?  *Boxborough, MA

*Who? *Qualified Wholesale Buyers
You are receiving this email as you, or someone from your company, has
either attended and/or inquired about the New England Made Shows.
Unsubscribe`;

const NEM_MODEL: RawItem[] = [
  {
    name: "New England Made Autumn Show 2026",
    start_date: "2026-09-15",
    end_date: "2026-09-16",
    venue: null,
    city: "Boxborough",
    state: "MA",
    excerpt: "New England Made Autumn Show 2026 When? September 15-16, 2026",
  },
];

/** 46d46ee0 — Maine Made October News, Constant Contact, received 2026-09-30. */
const MAINE_MADE = `---------- Forwarded message ---------
From: Maine Made <info@mainemade.ccsend.com>
Date: Wed, Sep 30, 2026 at 5:01 AM
Subject: Reminder: Maine Made October News for Carolyn

Upcoming Events:
Every day we're adding events to our calendar
<https://8m49v68ab.cc.rs6.net/tn.jsp?f=001a>
so that you can add them to yours. Pack the car and take an adventure!
Featured Event

Maine Craft Weekend
<https://8m49v68ab.cc.rs6.net/tn.jsp?f=001b>

October 3 & 4

AN ANNUAL STATEWIDE TOUR OF CRAFT ARTIST OPEN STUDIOS & EVENTS

Maine artisans are sharing their talents with these exciting hands-on
experiences:

Barn Board Pumpkins
<https://8m49v68ab.cc.rs6.net/tn.jsp?f=001c>
| October 1

Cold Process Soap Making
<https://8m49v68ab.cc.rs6.net/tn.jsp?f=001d>
| October 17

Watch:

   - Look for Cold Current Kelp
   <https://8m49v68ab.cc.rs6.net/tn.jsp?f=001e>
   to be on Shark Tank - September 30, 10:00 pm on ABC. We wish them the very
   best!

Unsubscribe | Update Profile | Constant Contact Data Notice`;

const MAINE_MADE_MODEL: RawItem[] = [
  {
    name: "Maine Craft Weekend",
    start_date: "XXXX-10-03",
    end_date: "XXXX-10-04",
    excerpt: "Maine Craft Weekend October 3 & 4",
  },
  {
    name: "Barn Board Pumpkins",
    start_date: "XXXX-10-01",
    excerpt: "Barn Board Pumpkins | October 1",
  },
  // The model filling in a year the newsletter never printed.
  {
    name: "Cold Process Soap Making",
    start_date: "2026-10-17",
    excerpt: "Cold Process Soap Making | October 17",
  },
  {
    name: "Shark Tank",
    start_date: "XXXX-09-30",
    excerpt: "to be on Shark Tank - September 30, 10:00 pm on ABC",
  },
];

// ── Grounding ──────────────────────────────────────────────────────────────

describe("groundItems — the model proposes, the newsletter decides", () => {
  const received = new Date("2026-10-02T00:14:00Z");

  it("ACCEPTANCE (24c583d5): one grounded item; the repeat is merged and the invented one dropped", () => {
    const { items, dropped } = groundItems(MLF_MODEL, cleanNewsletterText(MLF), received);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "80th Maine Lobster Festival",
      startDate: "2027-08-04",
      endDate: "2027-08-08",
      yearExplicit: true,
    });
    expect(dropped).toEqual([
      {
        name: "International Great Crate Race",
        excerpt: "The Great Crate Race returns Saturday, Aug. 7, 2027!",
        reason: "excerpt-not-in-body",
      },
    ]);
  });

  it("an excerpt that is real but does not state the item's date is dropped", () => {
    const { items, dropped } = groundItems(
      [
        {
          name: "Maine Lobster Festival",
          start_date: "2027-08-04",
          excerpt: "Enjoy five days of fun and feasting",
        },
      ],
      cleanNewsletterText(MLF),
      received
    );
    expect(items).toHaveLength(0);
    expect(dropped[0].reason).toBe("excerpt-has-no-date");
  });

  it("a list bullet between heading and item is layout; skipping a whole listing is a join, and refused", () => {
    // dde7e809's real shape (Bangor, "September Spectacular").
    const bangor = [
      "Saturday, Sept. 19",
      "",
      "   -",
      "",
      "   *Stephen King Roadshow appraisals, 9:00 AM – 12:00 PM (free) at",
      "   Nocturnem Draft Haus*",
      "",
      "Sunday, Sept 20th",
      "",
      "",
      "*Stephen King’s 79th Birthday Carnival, 2:00 PM – 05:00 PM (free) on Cross",
      "Street*",
      "",
      "*“Pet Sematary” Pet Parade, 5:00 PM – 5:30 PM (free) on Columbia Street*",
    ].join("\r\n");
    const { items, dropped } = groundItems(
      [
        {
          name: "Stephen King Roadshow appraisals",
          start_date: "XXXX-09-19",
          excerpt:
            "Saturday, Sept. 19 *Stephen King Roadshow appraisals, 9:00 AM – 12:00 PM (free) at Nocturnem Draft Haus*",
        },
        {
          name: "Pet Sematary Pet Parade",
          start_date: "XXXX-09-20",
          excerpt:
            "Sunday, Sept 20th *“Pet Sematary” Pet Parade, 5:00 PM – 5:30 PM (free) on Columbia Street*",
        },
      ],
      cleanNewsletterText(bangor),
      new Date("2026-09-17T12:00:00Z")
    );
    expect(items.map((i) => [i.name, i.startDate])).toEqual([
      ["Stephen King Roadshow appraisals", "2026-09-19"],
    ]);
    expect(dropped).toEqual([
      expect.objectContaining({ name: "Pet Sematary Pet Parade", reason: "excerpt-not-in-body" }),
    ]);
  });

  it("no excerpt, no item", () => {
    const { dropped } = groundItems(
      [{ name: "Maine Lobster Festival", start_date: "2027-08-04" }],
      cleanNewsletterText(MLF),
      received
    );
    expect(dropped[0].reason).toBe("no-excerpt");
  });

  it("a year counts only when the EXCERPT prints it — the model's 2026 for the soap class is not explicit", () => {
    const { items } = groundItems(
      MAINE_MADE_MODEL,
      cleanNewsletterText(MAINE_MADE),
      new Date("2026-09-30T09:01:00Z")
    );
    const soap = items.find((i) => i.name === "Cold Process Soap Making");
    expect(soap).toMatchObject({ yearExplicit: false, startDate: "2026-10-17" });
    expect(items.find((i) => i.name === "Maine Craft Weekend")).toMatchObject({
      startDate: "2026-10-03",
      endDate: "2026-10-04",
      yearExplicit: false,
    });
  });

  it("excerptStatesDate reads the formats the specimens use", () => {
    expect(excerptStatesDate("Aug. 4-8, 2027", 8, 4)).toBe(true);
    expect(excerptStatesDate("October 3 & 4", 10, 3)).toBe(true);
    expect(excerptStatesDate("When? September 15-16, 2026", 9, 15)).toBe(true);
    expect(excerptStatesDate("When? September 15-16, 2026", 9, 16)).toBe(false); // start day only
    expect(excerptStatesDate("Aug. 4-8, 2027", 7, 4)).toBe(false);
    // Ordinals — measured: the real model's excerpts for Piscataqua Riverfest,
    // two farmers' market issues and the D2P show all write the day this way.
    expect(
      excerptStatesDate("Saturday July 11th, 10a-4p Strawbery Banke, Portsmouth, NH", 7, 11)
    ).toBe(true);
    expect(excerptStatesDate("Market NotesAugust 6th, 2026", 8, 6)).toBe(true);
    expect(excerptStatesDate("the Design 2 Part Show September 30th and October 1st", 9, 30)).toBe(
      true
    );
    expect(excerptStatesDate("Saturday July 11th", 7, 1)).toBe(false);
    // …but a word that merely starts like a month is not one: "market 5th" ≠ March 5.
    expect(excerptStatesDate("Visit the market 5th Street entrance", 3, 5)).toBe(false);
    expect(excerptStatesDate("Augusta 04330", 8, 4)).toBe(false);
    expect(excerptStatesDate("dismay 5 times", 5, 5)).toBe(false);
    expect(excerptStatesDate("Market NotesJuly 30th, 2026", 7, 30)).toBe(true);
    expect(excerptStatesDate("Sept. 19, 5-7 pm", 9, 19)).toBe(true);
    expect(excerptStatesDate("May 2, 2027", 5, 2)).toBe(true);
  });

  it("inferYear: this autumn for an autumn issue, next year for a date well behind it", () => {
    const sep30 = new Date("2026-09-30T00:00:00Z");
    expect(inferYear(10, 3, sep30)).toBe(2026);
    expect(inferYear(9, 15, sep30)).toBe(2026); // a show that just happened
    expect(inferYear(3, 14, sep30)).toBe(2027);
  });

  it("parseItemsResponse takes the array out of prose, and survives garbage", () => {
    expect(parseItemsResponse({ response: 'Here you go:\n[{"name":"x"}]\nThanks' })).toEqual([
      { name: "x" },
    ]);
    expect(parseItemsResponse({ response: "no events" })).toEqual([]);
    expect(parseItemsResponse({ response: "[{bad json" })).toEqual([]);
    expect(parseItemsResponse({ response: [{ name: "y" }] })).toEqual([{ name: "y" }]);
  });
});

// ── Disposition ────────────────────────────────────────────────────────────

const hit = (id: string, matchType = "similar_name_date"): CheckDuplicateResult => ({
  isDuplicate: true,
  matchType: matchType as never,
  identifiesSameEvent: true,
  existingEvent: { id, slug: id, name: id, startDate: null, status: "APPROVED", sourceUrl: null },
});

function fakeDeps(
  byName: Record<string, CheckDuplicateResult>,
  stored: Record<string, { start: string; end: string | null }>
) {
  const citations: { eventId: string; fields: string[]; excerpt: string }[] = [];
  const discrepancies: { eventId: string; stored: string; newsletter: string }[] = [];
  const deps: DisposeDeps = {
    checkDuplicate: async (i) => byName[i.name ?? ""] ?? { isDuplicate: false },
    loadEventDates: async (id) => stored[id] ?? null,
    writeCitations: async (a) => {
      citations.push({
        eventId: a.eventId,
        fields: a.fields.map((f) => f.fieldName),
        excerpt: a.excerpt,
      });
      return a.fields.length;
    },
    writeDiscrepancy: async (a) => {
      discrepancies.push(a);
    },
  };
  return { deps, citations, discrepancies };
}

describe("disposeItems — what each item means for the events we hold", () => {
  it("ACCEPTANCE (24c583d5): matched to 425f8cdb, start/end citations carry the excerpt, nothing created", async () => {
    const { items } = groundItems(
      MLF_MODEL,
      cleanNewsletterText(MLF),
      new Date("2026-10-02T00:14:00Z")
    );
    const { deps, citations, discrepancies } = fakeDeps(
      { "80th Maine Lobster Festival": hit("425f8cdb") },
      { "425f8cdb": { start: "2027-08-04", end: "2027-08-08" } }
    );
    const out = await disposeItems(
      items,
      { promoterId: "e892bbce", receivedAt: new Date("2026-10-02") },
      deps
    );
    expect(out.map((o) => o.disposition)).toEqual([
      {
        kind: "matched",
        eventId: "425f8cdb",
        matchType: "similar_name_date",
        citedFields: ["start_date", "end_date"],
      },
    ]);
    expect(citations).toEqual([
      {
        eventId: "425f8cdb",
        fields: ["start_date", "end_date"],
        excerpt: expect.stringContaining("Aug. 4-8, 2027, at Harbor Park"),
      },
    ]);
    expect(discrepancies).toEqual([]);
  });

  it("ACCEPTANCE (a14543b8): the NEM footer show matches defe4089 — no shell row", async () => {
    const { items } = groundItems(
      NEM_MODEL,
      cleanNewsletterText(NEM),
      new Date("2026-08-17T12:16:00Z")
    );
    expect(items).toHaveLength(1);
    const { deps, citations } = fakeDeps(
      { "New England Made Autumn Show 2026": hit("defe4089", "city_state_date") },
      { defe4089: { start: "2026-09-15", end: "2026-09-16" } }
    );
    const out = await disposeItems(
      items,
      { promoterId: null, receivedAt: new Date("2026-08-17") },
      deps
    );
    expect(out[0].disposition).toMatchObject({
      kind: "matched",
      eventId: "defe4089",
      matchType: "city_state_date",
    });
    expect(citations[0].fields).toEqual(["start_date", "end_date"]);
    expect(out.some((o) => o.disposition.kind === "unmatched")).toBe(false);
  });

  it("ACCEPTANCE (46d46ee0): Maine Craft Weekend matches ac78fee2; zero new rows; yearless dates are never cited", async () => {
    const received = new Date("2026-09-30T09:01:00Z");
    const { items } = groundItems(MAINE_MADE_MODEL, cleanNewsletterText(MAINE_MADE), received);
    const { deps, citations } = fakeDeps(
      { "Maine Craft Weekend": hit("ac78fee2") },
      { ac78fee2: { start: "2026-10-03", end: "2026-10-04" } }
    );
    const out = await disposeItems(items, { promoterId: null, receivedAt: received }, deps);
    const by = Object.fromEntries(out.map((o) => [o.name, o.disposition]));
    expect(by["Maine Craft Weekend"]).toEqual({
      kind: "matched",
      eventId: "ac78fee2",
      matchType: "similar_name_date",
      citedFields: [],
    });
    expect(by["Barn Board Pumpkins"]).toEqual({ kind: "skipped", reason: "no-year" });
    expect(by["Cold Process Soap Making"]).toEqual({ kind: "skipped", reason: "no-year" });
    expect(by["Shark Tank"]).toEqual({ kind: "skipped", reason: "no-year" });
    expect(out.filter((o) => o.disposition.kind === "unmatched")).toHaveLength(0);
    expect(citations).toEqual([]);
  });

  it("ACCEPTANCE: a newsletter date that differs from ours files a discrepancy and NO corroborating citation", async () => {
    const { items } = groundItems(MLF_MODEL, cleanNewsletterText(MLF), new Date("2026-10-02"));
    const { deps, citations, discrepancies } = fakeDeps(
      { "80th Maine Lobster Festival": hit("425f8cdb") },
      { "425f8cdb": { start: "2027-08-05", end: "2027-08-09" } }
    );
    const out = await disposeItems(
      items,
      { promoterId: "e892bbce", receivedAt: new Date("2026-10-02") },
      deps
    );
    expect(out[0].disposition.kind).toBe("discrepancy");
    expect(discrepancies).toEqual([
      {
        eventId: "425f8cdb",
        stored: "2027-08-05 – 2027-08-09",
        newsletter: "2027-08-04 – 2027-08-08",
      },
    ]);
    expect(citations).toEqual([]);
  });

  it("a series_url hit only proves a shared listing page (OPE-454) — not a match", async () => {
    const { items } = groundItems(MLF_MODEL, cleanNewsletterText(MLF), new Date("2026-10-02"));
    const { deps, citations } = fakeDeps(
      {
        "80th Maine Lobster Festival": {
          ...hit("425f8cdb", "series_url"),
          identifiesSameEvent: false,
        } as CheckDuplicateResult,
      },
      { "425f8cdb": { start: "2027-08-04", end: "2027-08-08" } }
    );
    const out = await disposeItems(
      items,
      { promoterId: "e892bbce", receivedAt: new Date("2026-10-02") },
      deps
    );
    expect(out[0].disposition).toEqual({ kind: "unmatched", promoterId: "e892bbce" });
    expect(citations).toEqual([]);
  });

  it("an unmatched item with an explicit year is recorded as a would-be candidate; a past one is skipped", async () => {
    const { deps } = fakeDeps({}, {});
    const base = {
      venue: null,
      city: null,
      state: null,
      endDate: null,
      excerpt: "x",
      yearExplicit: true,
    };
    const out = await disposeItems(
      [
        { ...base, name: "Spring Show 2027", startDate: "2027-04-11" },
        { ...base, name: "Summer Show 2026", startDate: "2026-06-01" },
      ],
      { promoterId: "p9", receivedAt: new Date("2026-10-02") },
      deps
    );
    expect(out.map((o) => o.disposition)).toEqual([
      { kind: "unmatched", promoterId: "p9" },
      { kind: "skipped", reason: "past" },
    ]);
  });
});

// ── The workflow step, against a real database ────────────────────────────

describe("processNewsletter — what the newsletter/itemize step writes", () => {
  let db: TestDb;
  const aiReturning = (items: RawItem[]) => ({
    run: vi.fn(async () => ({ response: JSON.stringify(items) })),
  });

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(promoters)
      .values({ id: "e892bbce", companyName: "Maine Lobster Festival", slug: unsafeSlug("mlf") })
      .run();
    db.insert(events)
      .values({
        id: "425f8cdb",
        name: "Maine Lobster Festival 2027",
        slug: unsafeSlug("maine-lobster-festival-2027"),
        promoterId: "e892bbce",
        status: "APPROVED",
        startDate: new Date("2027-08-04T00:00:00Z"),
        endDate: new Date("2027-08-08T00:00:00Z"),
        createdAt: new Date("2026-01-01"),
      })
      .run();
    db.insert(inboundEmails)
      .values({
        id: "ie-24c583d5",
        receivedAt: new Date("2026-10-02T00:14:00Z"),
        createdAt: new Date("2026-10-02T00:14:00Z"),
        fromAddress: "jtarboxme@gmail.com",
        toAddress: "submit@meetmeatthefair.com",
        bodyText: MLF,
        originalSenderAddress: "info@mainelobsterfestival.com",
        originalSenderAuth: "unverifiable_inline_forward",
        intent: "submit",
        status: "received",
        attachmentCount: 0,
      } as never)
      .run();
    db.insert(inboundNewsletters)
      .values({
        inboundEmailId: "ie-24c583d5",
        markers: "esp:list-manage.com,bulk:unsubscribe",
        promoterId: "e892bbce",
        matchBasis: "sender-domain",
        senderAddress: "info@mainelobsterfestival.com",
        createdAt: new Date(),
      })
      .run();
  });

  const matcher = { checkDuplicate: async () => hit("425f8cdb") };
  const env = (items: RawItem[]) => ({ AI: aiReturning(items) });

  it("ACCEPTANCE (24c583d5): citations with the excerpt at capped confidence, the list persisted, zero new events", async () => {
    const r = await processNewsletter(db as never, env(MLF_MODEL), "ie-24c583d5", "wf-1", matcher);
    expect(r).toEqual({ status: "ok", counts: { matched: 1, dropped: 1 } });

    const cites = db
      .select()
      .from(eventDataCitations)
      .where(eq(eventDataCitations.eventId, "425f8cdb"))
      .all();
    expect(cites.map((c) => [c.fieldName, c.value]).sort()).toEqual([
      ["end_date", "2027-08-08"],
      ["start_date", "2027-08-04"],
    ]);
    for (const c of cites) {
      expect(c.sourceExcerpt).toContain("Aug. 4-8, 2027");
      expect(c.confidence).toBe(0.3); // unverifiable_inline_forward caps it
      expect(c.sourceUrl).toBe("email://jtarboxme@gmail.com/newsletter/ie-24c583d5");
      expect(c.state).toBe("active");
    }
    expect(db.select().from(events).all()).toHaveLength(1);
    // The event itself is untouched.
    expect(db.select().from(events).all()[0].startDate).toEqual(new Date("2027-08-04T00:00:00Z"));

    const [nl] = db.select().from(inboundNewsletters).all();
    const rec = JSON.parse(nl.itemsJson!);
    expect(rec.items[0].disposition).toMatchObject({ kind: "matched", eventId: "425f8cdb" });
    expect(rec.dropped).toEqual([
      expect.objectContaining({
        name: "International Great Crate Race",
        reason: "excerpt-not-in-body",
      }),
    ]);

    const steps = db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.stepName, "newsletter/itemize"))
      .all();
    expect(steps.map((s) => s.status)).toEqual(["ok"]);
  });

  it("a replay neither re-asks the model nor cites twice", async () => {
    await processNewsletter(db as never, env(MLF_MODEL), "ie-24c583d5", "wf-1", matcher);
    const second = env(MLF_MODEL);
    const r = await processNewsletter(db as never, second, "ie-24c583d5", "wf-1", matcher);
    expect(r.status).toBe("skipped");
    expect(second.AI.run).not.toHaveBeenCalled();
    expect(db.select().from(eventDataCitations).all()).toHaveLength(2);
  });

  it("ACCEPTANCE: a disagreeing date writes an event_discrepancies row (detector `newsletter`, never outreach) and no citation", async () => {
    db.update(events)
      .set({ startDate: new Date("2027-08-05T00:00:00Z") })
      .where(eq(events.id, "425f8cdb"))
      .run();
    await processNewsletter(db as never, env(MLF_MODEL), "ie-24c583d5", "wf-1", matcher);
    const [d] = db
      .select()
      .from(eventDiscrepancies)
      .where(
        and(
          eq(eventDiscrepancies.eventId, "425f8cdb"),
          eq(eventDiscrepancies.detectedBy, "newsletter")
        )
      )
      .all();
    expect(d).toMatchObject({
      fieldClass: "date",
      authoritativeValue: "2027-08-05 – 2027-08-08",
      divergentValue: "2027-08-04 – 2027-08-08",
      outreachCandidate: false,
      // The write-time guard's OWN effect: only forceOutreachCandidate:false
      // sets this (capture.ts). outreachCandidate alone is false for a fresh
      // low score too, so it cannot tell the guard is there.
      outreachSuppressed: true,
    });
    // …and the re-ranker's guard, which holds even if a later rerank scores it up.
    expect(NEVER_OUTREACH_DETECTORS.has("newsletter")).toBe(true);
    expect(db.select().from(eventDataCitations).all()).toHaveLength(0);
  });

  it("a model failure costs the itemizing, not the email: step recorded failed, items_json stays NULL for a retry", async () => {
    const broken = { AI: { run: vi.fn(async () => Promise.reject(new Error("5028 model gone"))) } };
    const r = await processNewsletter(db as never, broken, "ie-24c583d5", "wf-1", matcher);
    expect(r.status).toBe("failed");
    expect(db.select().from(inboundNewsletters).all()[0].itemsJson).toBeNull();
    const [s] = db.select().from(workflowRunSteps).all();
    expect(s.status).toBe("failed");
    expect(JSON.parse(s.detail ?? "{}").error).toContain("5028");
  });
});

describe("the workflow runs itemize only for a newsletter, and never lets it fail the email (source-level)", () => {
  const WF = readFileSync(`${__dirname}/../src/workflows/inbound-email.ts`, "utf8");
  it("after classify, guarded by isNewsletter, inside a try", () => {
    const classify = WF.indexOf('"newsletter/classify",');
    const itemize = WF.indexOf('"newsletter/itemize",');
    expect(classify).toBeGreaterThan(-1);
    expect(itemize).toBeGreaterThan(classify);
    const before = WF.slice(classify, itemize);
    expect(before).toMatch(/if \(newsletter\.isNewsletter\) \{\s*try \{\s*await step\.do\(\s*$/);
  });
});
