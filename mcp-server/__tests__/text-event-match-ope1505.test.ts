/**
 * OPE-1505 — recognising an event we already list from an email's text alone.
 *
 * Fixtures are the three specimens from the ticket, trimmed and with addresses
 * replaced; the candidate lists are the prod events those emails were about
 * (read 2026-10-20), so the competition each match has to win is real.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { events, venues, eventNameVariants } from "../src/schema.js";
import {
  scoreCandidates,
  decideTextMatch,
  matchEventFromText,
  mentionedMonthDays,
  nameQueries,
  type TextMatchCandidateInput,
} from "../src/inbound/text-event-match.js";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function cand(
  id: string,
  name: string,
  start: string,
  city: string | null,
  extra: Partial<TextMatchCandidateInput> = {}
): TextMatchCandidateInput {
  return {
    id,
    slug: id,
    name,
    variants: [],
    startDate: sec(`${start}T00:00:00Z`),
    endDate: null,
    city,
    promoterName: null,
    ...extra,
  };
}

function decide(
  email: { subject: string; bodyText: string; receivedAt: number },
  candidates: TextMatchCandidateInput[]
) {
  return decideTextMatch(scoreCandidates(email, candidates), ["x"]);
}

// ── inbound 01ad5525 ────────────────────────────────────────────────────────
const MANCHESTER = {
  subject: "Fwd: Manchester Grange Craft Fair",
  receivedAt: sec("2026-10-14T22:44:00Z"),
  bodyText: [
    "---------- Forwarded message ---------",
    "From: Organizer <organizer@example.org>",
    "Date: Wed, Oct 14, 2026 at 4:08 PM",
    "Subject: Manchester Grange Craft Fair",
    "To: <vendor@example.org>",
    "",
    "Hello,",
    "",
    "The Manchester Grange Fall Craft Fair is only 10 days away! We're so",
    "excited to have you as a vendor.",
    "",
    "Set-up times are Friday October 23rd from 4-6pm and Saturday October 24th",
    "from 7-8am. The fair goes from 8am to 2pm. Clean-up is from 2-4pm.",
    "There is a ramp at the back of the building which may be easier to use than",
    "the front of the building which has stairs.",
    "The Lions Club will be selling breakfast and lunch as well.",
  ].join("\n"),
};
const MANCHESTER_CANDIDATES = [
  cand("018f8c98", "Manchester Grange Fall Craft Fair", "2026-10-24", "Manchester"),
  // Same word "Grange", another town — the shape that defeated single words.
  cand("other-grange", "Readfield Grange Holiday Fair", "2026-12-05", "Readfield"),
  cand("other-manchester", "Manchester Harvest Festival", "2026-09-12", "Manchester"),
];

// ── inbound 62252aa2 ────────────────────────────────────────────────────────
const HAMFEST = {
  subject: "Fwd: Hamfest",
  receivedAt: sec("2026-09-15T12:45:00Z"),
  bodyText: [
    "---------- Forwarded message ---------",
    "From: Ham Radio <ham@example.org>",
    "Date: Tue, Sep 15, 2026, 07:33",
    "Subject: Hamfest",
    "",
    "Hello folks,",
    "",
    "This Saturday, Sep 19 is the Alexander Hamfest at the Alexander Elementary",
    "School in Alexander on the Airline RD (RT-9). 8am until noon.  Hope to see",
    "you there!",
  ].join("\n"),
};
const HAMFEST_CANDIDATES = [
  cand("7e0b56ef", "Alexander Hamfest 2026", "2026-09-19", "Alexander"),
  cand("hermon", "Hermon Hamfest 2026", "2026-07-11", "Hermon"),
  cand("windsor", "Windsor Hamfest 2026", "2026-09-12", "Windsor"),
  cand("nutmeg", "Nutmeg Hamfest, ARRL Connecticut State Convention", "2026-10-11", "Meriden"),
  cand("arrl-me", "ARRL Maine State Convention & Hamfest", "2026-08-01", "Augusta"),
];

// ── inbound 24c583d5 ────────────────────────────────────────────────────────
const LOBSTER = {
  subject: "Fwd: Maine Lobster Festival Newsletter 🦞",
  receivedAt: sec("2026-10-01T19:34:00Z"),
  bodyText: [
    "---------- Forwarded message ---------",
    "From: Maine Lobster Festival <info@example.org>",
    "Date: Thu, Oct 1, 2026 at 3:50 PM",
    "Subject: Maine Lobster Festival Newsletter 🦞",
    "",
    "Just in case you're already counting down the days until the 2027 Maine",
    "Lobster Festival (we can't be the only ones), there are only 307 days left",
    "to wait! Mark your calendar for the 80th Maine Lobster Festival, Aug. 4-8,",
    "2027, at Harbor Park in Rockland, Maine!",
  ].join("\n"),
};
const LOBSTER_CANDIDATES = [
  cand("425f8cdb", "Maine Lobster Festival 2027", "2027-08-04", "Rockland", {
    endDate: sec("2027-08-08T00:00:00Z"),
  }),
  cand("0196de10", "Maine Lobster Festival 2026", "2026-07-29", "Rockland", {
    endDate: sec("2026-08-02T00:00:00Z"),
  }),
  cand("winter-harbor", "Winter Harbor Lobster Festival 2026", "2026-08-08", "Winter Harbor"),
];

describe("OPE-1505 — the specimens match the event we list (ACCEPTANCE)", () => {
  it("01ad5525 (Manchester Grange) matches 018f8c98 — from text alone, no extraction", () => {
    const r = decide(MANCHESTER, MANCHESTER_CANDIDATES);
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("018f8c98");
    expect(r.matched?.reasons.join("; ")).toMatch(/date 2026-10-24 named in text/);
  });

  it("62252aa2 (Hamfest) matches the Alexander Hamfest, not the other five hamfests", () => {
    const r = decide(HAMFEST, HAMFEST_CANDIDATES);
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("7e0b56ef");
  });

  it("24c583d5 (Lobster Festival newsletter) matches the 2027 edition the email is about", () => {
    const r = decide(LOBSTER, LOBSTER_CANDIDATES);
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("425f8cdb");
    // The 2026 edition was a real candidate, and lost on the evidence.
    const lost = r.candidates.find((c) => c.id === "0196de10");
    expect(lost?.eligible).toBe(true);
    expect(lost?.reasons).toContain("already over when the email arrived");
  });
});

describe("OPE-1505 — no false match", () => {
  it("a Grange fair we do NOT list matches nothing, though it shares 'Grange' and the date", () => {
    const r = decide(
      {
        subject: "Fwd: Litchfield Grange Craft Fair",
        receivedAt: MANCHESTER.receivedAt,
        bodyText:
          "The Litchfield Grange Craft Fair is Saturday October 24th, 8am to 2pm. Tables are $20.",
      },
      MANCHESTER_CANDIDATES
    );
    expect(r.outcome).toBe("below-threshold");
    expect(r.matched).toBeNull();
    // The positive landmark: the candidates WERE examined and scored.
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("two editions the text cannot tell apart are ambiguous, not a guess", () => {
    const r = decide(
      {
        subject: "Fwd: Maine Lobster Festival",
        receivedAt: sec("2027-01-10T12:00:00Z"),
        bodyText: "Thanks for listing the Maine Lobster Festival!",
      },
      [
        cand("a", "Maine Lobster Festival 2027", "2027-08-04", "Rockland"),
        cand("b", "Maine Lobster Festival 2028", "2028-08-02", "Rockland"),
      ]
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.matched).toBeNull();
  });

  it("one generic shared word cannot make a match on its own", () => {
    const r = decide(
      {
        subject: "Fwd: Hamfest",
        receivedAt: HAMFEST.receivedAt,
        bodyText: "See you at the hamfest!",
      },
      HAMFEST_CANDIDATES
    );
    expect(r.outcome).toBe("below-threshold");
  });

  it("a date or town alone never promotes an event the email does not name", () => {
    const r = decide(
      {
        subject: "Fwd: Craft Fair",
        receivedAt: MANCHESTER.receivedAt,
        bodyText: "Our fair is in Manchester on Saturday October 24th.",
      },
      MANCHESTER_CANDIDATES
    );
    expect(r.matched).toBeNull();
  });

  it("a ONE-token name needs its whole phrase: 'Fryeburg' alone is not 'Fryeburg Fair'", () => {
    const fryeburg = [cand("fry", "Fryeburg Fair 2026", "2026-10-04", "Fryeburg")];
    const mentionOnly = decide(
      {
        subject: "Fwd: Fryeburg vendor list",
        receivedAt: sec("2026-09-01T12:00:00Z"),
        bodyText: "We are a Fryeburg pottery studio and sell at several shows.",
      },
      fryeburg
    );
    expect(mentionOnly.matched).toBeNull();
    const named = decide(
      {
        subject: "Fwd: Fryeburg Fair",
        receivedAt: sec("2026-09-01T12:00:00Z"),
        bodyText: "See you at the Fryeburg Fair!",
      },
      fryeburg
    );
    expect(named.matched?.id).toBe("fry");
  });

  it("the NAMED DATE alone separates two upcoming editions of one series in one year", () => {
    // Same name, same town, same year, both upcoming — only "December 5th"
    // says which. Without the date evidence this is a tie.
    const r = decide(
      {
        subject: "Fwd: Readfield Grange Holiday Fair",
        receivedAt: sec("2026-10-20T12:00:00Z"),
        bodyText: "The Readfield Grange Holiday Fair is Saturday, December 5th.",
      },
      [
        cand("nov", "Readfield Grange Holiday Fair", "2026-11-07", "Readfield"),
        cand("dec", "Readfield Grange Holiday Fair", "2026-12-05", "Readfield"),
      ]
    );
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("dec");
  });

  it("a name variant counts as the event's name", () => {
    const r = decide(
      {
        subject: "Fwd: Big E reminder",
        receivedAt: sec("2026-09-01T12:00:00Z"),
        bodyText: "The Eastern States Exposition opens September 12th in West Springfield.",
      },
      [
        cand("big-e", "The Big E 2026", "2026-09-12", "West Springfield", {
          variants: ["Eastern States Exposition"],
        }),
      ]
    );
    expect(r.outcome).toBe("matched");
    expect(r.matched?.reasons[0]).toMatch(/via variant "Eastern States Exposition"/);
  });
});

describe("OPE-1505 — text helpers", () => {
  it("dates in forward headers are ignored; dates in the body are read", () => {
    const d = mentionedMonthDays(HAMFEST.bodyText);
    expect(d.has("9-19")).toBe(true);
    expect(d.has("9-15")).toBe(false); // "Date: Tue, Sep 15, 2026" is the forward's
  });

  it("queries include the forward's quoted Subject line", () => {
    expect(nameQueries("Fwd: FW: something", "Subject: Manchester Grange Craft Fair")).toContain(
      "Manchester Grange Craft Fair"
    );
  });
});

// ── Retrieval against a real schema ─────────────────────────────────────────
describe("OPE-1505 — matchEventFromText over D1", () => {
  let db: TestDb;
  beforeEach(async () => {
    ({ db } = createTestDb());
    await db.insert(venues).values([
      {
        id: "v-man",
        name: "Manchester Grange",
        slug: "manchester-grange",
        address: "1 Main St",
        zip: "04351",
        city: "Manchester",
        state: "ME",
      },
      {
        id: "v-rf",
        name: "Readfield Grange",
        slug: "readfield-grange",
        address: "2 Main St",
        zip: "04355",
        city: "Readfield",
        state: "ME",
      },
    ] as never);
    const ev = (id: string, name: string, start: string, status: string, extra = {}) => ({
      id,
      name,
      slug: id,
      status,
      lifecycleStatus: "SCHEDULED",
      promoterId: "p1",
      venueId: "v-man",
      startDate: new Date(`${start}T00:00:00Z`),
      endDate: new Date(`${start}T00:00:00Z`),
      createdAt: new Date("2026-08-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
      ...extra,
    });
    await db.insert(events).values([
      ev("018f8c98", "Manchester Grange Fall Craft Fair", "2026-10-24", "APPROVED"),
      // The merge tombstone and the rejected duplicate both carry the right name
      // and date. Neither may be matched: a tombstone redirects away, and a
      // rejected row is not a listing.
      ev("eec93e7e", "Manchester Grange 2026 Fall Craft Fair", "2026-10-24", "REJECTED", {
        mergedInto: "018f8c98",
      }),
      ev("rej", "Manchester Grange Fall Craft Fair (dup)", "2026-10-24", "REJECTED"),
      ev("rf", "Readfield Grange Holiday Fair", "2026-12-05", "APPROVED", { venueId: "v-rf" }),
    ] as never);
  });

  it("ACCEPTANCE: 01ad5525 matches 018f8c98; the tombstone and the rejected row are never candidates", async () => {
    const r = await matchEventFromText(db as never, MANCHESTER);
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("018f8c98");
    expect(r.searched).toEqual(expect.arrayContaining(["manchester", "grange"]));
    const ids = r.candidates.map((c) => c.id);
    expect(ids).not.toContain("eec93e7e");
    expect(ids).not.toContain("rej");
    expect(ids).toContain("rf"); // retrieved on "grange", scored, refused
  });

  it("finds an event through its name variant", async () => {
    await db.insert(eventNameVariants).values({
      eventId: "rf",
      variant: "Readfield Christmas Bazaar",
      createdAt: new Date(),
    } as never);
    const r = await matchEventFromText(db as never, {
      subject: "Fwd: Christmas Bazaar",
      bodyText: "The Readfield Christmas Bazaar is December 5th.",
      receivedAt: sec("2026-11-01T12:00:00Z"),
    });
    expect(r.outcome).toBe("matched");
    expect(r.matched?.id).toBe("rf");
  });

  it("no distinctive word → no-query, and nothing is read", async () => {
    const r = await matchEventFromText(db as never, {
      subject: "Fwd: Craft Fair",
      bodyText: "",
      receivedAt: MANCHESTER.receivedAt,
    });
    expect(r.outcome).toBe("no-query");
  });
});
