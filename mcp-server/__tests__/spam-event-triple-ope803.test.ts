/**
 * OPE-803 — the triple detector, tested against the ACTUAL spam corpus.
 *
 * Every string below is copied verbatim out of D1 `inbound_emails` on
 * 2026-09-04, not written for the test. That matters here more than usual: the
 * corpus is 53% one weekly marketing newsletter and 16% John forwarding himself
 * GitHub CI failures, and a detector tuned against imagined broker pitches
 * would fire on both. The adversarial cases are real mail, not hypotheses.
 */
import { describe, expect, it } from "vitest";
import { detectEventTriple } from "../src/email-handlers/spam-event-triple.js";

// ── Verbatim corpus fixtures ────────────────────────────────────────────

/** `912c661e` — the trigger. Full body, retained because OPE-762 shipped 09-02. */
const LUCY_MORGAN_BODY = `Hi,

I hope you're doing well.

We're pleased to offer access to the *New England Made Giftware & Specialty
Food Show 2026 Pre-Registered Attendee List*, at a special discounted price
for a limited time.

The list is intended to help businesses connect with professionals and
decision-makers from the *giftware, specialty food & beverage, retail,
wholesale, and consumer goods industries* before, during, and after the
event, supporting targeted outreach, lead generation, and meeting
opportunities.

*Event:* New England Made Giftware & Specialty Food Show 2026
*Date:* 15 – 16 September 2026
*Location:* Boxboro Regency Hotel & Conference Centre, Boxborough,
Massachusetts, USA
*Pre-Registered Attendees/Visitors:* 1,500

Thanks & Regards,

Lucy Morgan
`;

/** The first 500 chars of the same message — all that was stored pre-OPE-762. */
const LUCY_MORGAN_EXCERPT = LUCY_MORGAN_BODY.slice(0, 500);

/** `91a9a9e5` — John forwarding himself a CI failure. 3 of 19 rows are these. */
const GITHUB_FORWARD = `---------- Forwarded message ---------
From: John Tarbox <notifications@github.com>
Date: Mon, Aug 17, 2026, 10:53
Subject: [JohnTarbox/takemetothefair-cloudflare] Run failed: CI - main
(475a81a)
To: JohnTarbox/takemetothefair-cloudflare <
takemetothefair-cloudflare@noreply.github.com>
Cc: Ci activity <ci_activity@noreply.github.com>



[image: GitHub] [JohnTarbox/takemetothefair-cloudflare] CI workflow run

  CI: Some jobs were not successful

View workflow run
<https://github.com/JohnTarbox/ta`;

/** `f9097ca7` — the weekly newsletter. 10 of the 19 rows are this template. */
const PROVENROI = `Friend, welcome to the Proven ROI weekly newsletter. Each week, you will get practical insights, ideas, and strategies you can use to improve your marketing and drive better results.

Proven ROI (https://hubspot.hyperwarpspeed.com/e3t/Ctc/I8+113/d2z51J04/MWqsl4qS9QwW6bsXB41ZNX5KW3Z50n15TqCdtN3Lg87-3l5Qz`;

/** `3daf44ee` — guest-post spam. Commercial, no event. */
const BACKLINK_DEALER = `Hi Team,

I hope you are doing well.

My name is Amy Wilson from Backlink Dealer. We work with SEO agencies,
eCommerce brands, and SaaS companies across the globe, helping websites
monetize through paid guest posts, link insertions, and digital PR
placements — across niches like tech, fashion, DIY, crafts, finance, food,
travel, shopping, automobiles etc.`;

const call = (bodyText: string | null, subject?: string, excerpt?: string | null) =>
  detectEventTriple({ bodyText, bodyTextExcerpt: excerpt ?? null, subject: subject ?? null });

// ── The one row that should hit ─────────────────────────────────────────

describe("the specimen the ticket was filed on", () => {
  it("finds all three, verbatim, off the full body", () => {
    const r = call(
      LUCY_MORGAN_BODY,
      "Complete Visitor List for New England Made Giftware & Specialty Food Show 2026"
    );
    expect(r.hit).toBe(true);
    expect(r.read).toBe("body");
    expect(r.truncated).toBe(false);
    expect(r.name).toBe("New England Made Giftware & Specialty Food Show 2026");
    expect(r.dateText).toBe("15 – 16 September 2026");
    expect(r.place).toContain("Boxboro Regency Hotel");
  });

  it("⚠️ MISSES on the 500-char excerpt — which is all that existed before OPE-762", () => {
    // This is the finding, asserted rather than described. The excerpt cuts at
    // "meeting opportunities." and the labelled block begins at char ~500, so
    // the ticket's Scope §1 ("test the excerpt") would have failed on the very
    // row it was filed on.
    const r = call(null, undefined, LUCY_MORGAN_EXCERPT);
    expect(r.hit).toBe(false);
    expect(r.read).toBe("excerpt");
    // ...and it says the miss is inconclusive rather than reporting a clean no.
    expect(r.truncated).toBe(true);
  });

  it("the excerpt still carries the NAME, so the miss is date+place only", () => {
    // Positive landmark: proves the excerpt fixture is real text the detector
    // can read, not an empty string passing the assertion above vacuously.
    const r = call(null, undefined, LUCY_MORGAN_EXCERPT);
    expect(r.name).toContain("New England Made Giftware");
    expect(r.dateText).toBeNull();
    expect(r.place).toBeNull();
  });
});

// ── The rows that must stay silent ──────────────────────────────────────

describe("the real corpus must not fire", () => {
  it("a forwarded GitHub CI failure — a Date: and a Subject: sitting together", () => {
    const r = call(
      GITHUB_FORWARD,
      "Fwd: [JohnTarbox/takemetothefair-cloudflare] Run failed: CI - main"
    );
    expect(r.hit).toBe(false);
    // ⚠️ Assert the DATE, not just the miss. Checking `hit` alone does not
    // exercise stripHeaderNoise at all: with the stripper deleted this row
    // still misses, because `name` and `place` are independently null. The
    // stripper's actual effect is here — without it this reads
    // `"Mon, Aug 17, 2026, 10:53"` off the transport header.
    expect(r.dateText).toBeNull();
  });

  it("a forwarded EVENT announcement — the shape where the strip is load-bearing", () => {
    // The case the GitHub row cannot cover. Here the body supplies a real name
    // and a real place, so the only thing standing between this and a hit is
    // the date. Unstripped, the RFC-822 header hands over the moment the mail
    // was FORWARDED — and the row would land in review asserting the fair
    // happens on 17 August, which is the day John hit forward.
    //
    // A wrong date that looks like a right one is worse than no date: it is
    // the shape OPE-278 shipped, where extraction ran on the envelope rather
    // than on the event.
    const forwarded = `---------- Forwarded message ---------
From: Chamber of Commerce <news@chamber.example>
Date: Mon, Aug 17, 2026, 10:53
Subject: This weekend
To: John Tarbox <jtarboxme@gmail.com>

Don't miss the Cotuit Harvest Fair at the Barnstable County Fairgrounds.`;
    const r = call(forwarded, "Fwd: This weekend");
    expect(r.name).toContain("Cotuit Harvest Fair");
    expect(r.place).toContain("Fairgrounds");
    // Both other signals present — so `hit` now depends entirely on the strip.
    expect(r.dateText).toBeNull();
    expect(r.hit).toBe(false);
  });

  it("the provenroi weekly newsletter — 10 of the 19 rows", () => {
    const r = call(PROVENROI, "Friend, Proven Strategies. Real ROI. Your Weekly Marketing Edge");
    expect(r.hit).toBe(false);
  });

  it("guest-post spam naming industries but no event", () => {
    const r = call(BACKLINK_DEALER, "Monetize Your Website with Paid Guest Posts!");
    expect(r.hit).toBe(false);
  });

  it("the TikTok verification code — no body at all", () => {
    // `97003970` is the only row with a zero-length excerpt too.
    const r = call(null, "TikTok Shop Partner Center verification code", null);
    expect(r.hit).toBe(false);
    expect(r.read).toBe("none");
    expect(r.truncated).toBe(true);
  });
});

// ── The discriminating predicates, one at a time ────────────────────────

describe("what each signal actually requires", () => {
  it("an UNLABELLED date must carry a year; a LABELLED one need not", () => {
    // The asymmetry is deliberate, so it is pinned from both sides.
    //
    // Unlabelled: "September 12" floating in prose is ordinary marketing copy,
    // and 10 of the 19 live rows are a weekly marketing newsletter. A detector
    // that fired on loose month-day text would be muted within a week.
    const looseNoYear = call("Cotuit Craft Fair is coming on September 12 to Cotuit, MA");
    expect(looseNoYear.dateText).toBeNull();
    expect(looseNoYear.hit).toBe(false);

    const looseWithYear = call("Cotuit Craft Fair runs 12 September 2026 in Cotuit, MA");
    expect(looseWithYear.dateText).toBe("12 September 2026");
    expect(looseWithYear.hit).toBe(true);

    // Labelled: a template writing the word "Date" next to a value is stating
    // an event date. Brokers really do write "*Date:* Sept 12-13", and
    // requiring a year would reject the genre this ticket exists to catch.
    const labelledNoYear = call("Event: Cotuit Craft Fair\nDate: Sept 12-13\nLocation: Cotuit, MA");
    expect(labelledNoYear.dateText).toBe("Sept 12-13");
    expect(labelledNoYear.hit).toBe(true);
  });

  it("a single capitalised word is not an event name", () => {
    const r = call("Come to the Show\nDate: 12 September 2026\nLocation: Cotuit, MA");
    // "the Show" has one real capitalised token; not a name.
    expect(r.name).not.toBe("the Show");
  });

  it("a venue noun is a place even with no city named", () => {
    const r = call("Blue Hill Fair 2026 runs 5 September 2026 at the Blue Hill Fairgrounds.");
    expect(r.hit).toBe(true);
    expect(r.place).toContain("Fairgrounds");
  });

  it("an event noun is required — a company announcement is not an event", () => {
    const r = call("Acme Consulting Group Limited\nDate: 15 September 2026\nLocation: Boston, MA");
    expect(r.name).toBeNull();
    expect(r.hit).toBe(false);
  });

  it("all three are required, not two", () => {
    expect(call("Cotuit Craft Fair 2026 on 12 September 2026").hit).toBe(false); // no place
    expect(call("Cotuit Craft Fair 2026 in Cotuit, MA").hit).toBe(false); // no date
    expect(call("Held 12 September 2026 in Cotuit, MA").hit).toBe(false); // no name
  });
});

describe("read/truncated distinguish 'nothing there' from 'nothing kept'", () => {
  it("a body-backed miss is conclusive; an excerpt-backed miss is not", () => {
    // The OPE-804 lesson, one lane over: an absent signal and a negative
    // signal must not be the same value.
    expect(call(PROVENROI).truncated).toBe(false);
    expect(call(null, undefined, PROVENROI).truncated).toBe(true);
  });
});

describe("the flag gate — the only thing standing between detection and routing", () => {
  it('stays shut on the shipped value, and on every value that is not exactly "true"', async () => {
    const { shouldRecoverSpamRow } = await import("../src/email-handlers/spam-event-triple.js");
    const hit = { hit: true };
    // The shipped value.
    expect(shouldRecoverSpamRow(hit, "false")).toBe(false);
    // ⚠️ The one that matters. A truthiness check on a Workers [vars] entry
    // reads the STRING "false" as enabled — which is how a feature ships dark
    // and runs anyway.
    expect(shouldRecoverSpamRow(hit, "False")).toBe(false);
    expect(shouldRecoverSpamRow(hit, "0")).toBe(false);
    expect(shouldRecoverSpamRow(hit, "")).toBe(false);
    expect(shouldRecoverSpamRow(hit, undefined)).toBe(false);
    expect(shouldRecoverSpamRow(hit, null)).toBe(false);
  });

  it("opens only on a hit AND the flag — never on one alone", async () => {
    const { shouldRecoverSpamRow } = await import("../src/email-handlers/spam-event-triple.js");
    expect(shouldRecoverSpamRow({ hit: true }, "true")).toBe(true);
    // Positive landmark above; the two half-conditions below must not open it.
    expect(shouldRecoverSpamRow({ hit: false }, "true")).toBe(false);
    expect(shouldRecoverSpamRow({ hit: true }, "false")).toBe(false);
  });

  it("the specimen would be recovered if John flips the flag; nothing else in the corpus would", async () => {
    const { shouldRecoverSpamRow } = await import("../src/email-handlers/spam-event-triple.js");
    const lucy = detectEventTriple({
      bodyText: LUCY_MORGAN_BODY,
      bodyTextExcerpt: null,
      subject: null,
    });
    expect(shouldRecoverSpamRow(lucy, "true")).toBe(true);
    for (const [body, subject] of [
      [PROVENROI, "Friend, Proven Strategies. Real ROI. Your Weekly Marketing Edge"],
      [GITHUB_FORWARD, "Fwd: Run failed: CI - main"],
      [BACKLINK_DEALER, "Monetize Your Website with Paid Guest Posts!"],
    ] as Array<[string, string]>) {
      const t = detectEventTriple({ bodyText: body, bodyTextExcerpt: null, subject });
      expect(shouldRecoverSpamRow(t, "true")).toBe(false);
    }
  });
});
