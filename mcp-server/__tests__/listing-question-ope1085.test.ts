/**
 * OPE-1085 — a reader who ASKS about a listing must not be told we recorded
 * their correction request.
 *
 * Every body below is a real one, copied from `inbound_emails` in prod. They are
 * the whole population of the `correction` lane that matters here: the 7
 * arrivals of the event-page mailto (2026-09-13 → 09-19) plus the non-template
 * rows that the first draft of this detector wrongly caught.
 *
 * The finding this pins, from an ablation against the real model: neither cue
 * moves the classifier alone — our `Question about …` subject alone reads
 * `support` at 0.90, our own event URL in the body alone reads `support` at
 * 0.90 — but together they read `correction` at 0.85 and clear a `>= 0.85` gate
 * with zero margin.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { isListingQuestion, readerProse, isBlankAskAboutEventBody } from "@takemetothefair/utils";

const SUBJ = "Question about Johnston Apple Festival and Artisan Market 2026";
const URL_J = "https://meetmeatthefair.com/events/johnston-apple-festival-and-artisan-market";

// ---- real bodies, verbatim from prod ----
const COREY_FBD5B1FC = `Can you rent wheelchairs at the festival?\n\n---\n${URL_J}\n\n`;
const GARLIC_3F1285D6 =
  "Is the Olde Mystic Village Garlic Festival 2026 Pet (Dog) Friendly?\n\n---\nhttps://meetmeatthefair.com/events/olde-mistick-village-garlic-festival-2026\n\n";
const WRISTBAND_6A9A7373 =
  "Are you selling wrist bands for the rides and if you are how much are they?\n\n---\nhttps://meetmeatthefair.com/events/four-town-fair/2026\n\nSent from my iPhone\n";
const KIMBERLEY_D062567B =
  "\n\n---\nhttps://meetmeatthefair.com/events/a-different-drummer-craft-fair-september/2026\nWill it still be held in the rain today? \n-Kimberley";
const BLANK_6E713A8E =
  "\n\n---\nhttps://meetmeatthefair.com/events/fall-festival-outdoor-craft-market-fayerweather/2026";
const BLANK_1B72B1C3 =
  "\n\n---\nhttps://meetmeatthefair.com/events/johnny-appleseed-arts-and-cultural-festival\n\nSent from my iPhone";

/** `46af4630` — NOT the template. A genuine date correction, phrased as a
 *  question. The first draft of this detector caught it; requiring the
 *  template is what excludes it. */
const CANADA_46AF4630 =
  "\nHello,\n\nYour website states the Salem Haunted Happenings Grande Parade is Friday  October 2 at 630pm. Other websites I have looked at state the parade is happening on Thursday October 1 at 630pm. Could you please clarify, we are coming from Canada and do not want to miss out on this amazing event.\n";

/** `f4a99ffb` — a real correction, with our URL in it. */
const PARADISE_F4A99FFB =
  "Hi there,\n\nWe did not submit our event\n<https://meetmeatthefair.com/events/paradise-city-arts-festival-fall/2026>\nto be listed on your site. Appreciate it being included, but the dates are\nwrong.\n";

describe("OPE-1085 — the four template questions fire", () => {
  it("ACCEPTANCE: Corey's wheelchair question is a question, not a correction", () => {
    expect(isListingQuestion({ subject: SUBJ, body: COREY_FBD5B1FC })).toBe(true);
  });

  it("the other three real questions fire too, above and below the fence", () => {
    expect(
      isListingQuestion({
        subject: "Question about Olde Mistick Village Garlic Festival 2026",
        body: GARLIC_3F1285D6,
      })
    ).toBe(true);
    expect(
      isListingQuestion({ subject: "Question about Four Town Fair 2026", body: WRISTBAND_6A9A7373 })
    ).toBe(true);
    // Kimberley typed BELOW the URL — the reader's words are still hers.
    expect(
      isListingQuestion({
        subject: "Question about A Different Drummer Craft Fair September 2026",
        body: KIMBERLEY_D062567B,
      })
    ).toBe(true);
  });

  it("a question with no question mark still counts (interrogative opener)", () => {
    expect(
      isListingQuestion({ subject: SUBJ, body: `Can we bring a stroller\n\n---\n${URL_J}` })
    ).toBe(true);
  });
});

describe("OPE-1085 — what must NOT fire", () => {
  it("the falsifier: a genuine correction phrased as a question, sent outside the template", () => {
    // He asks "could you please clarify" and there is no correction keyword in
    // it, so the prose test alone says question. The template requirement is
    // the only thing standing between him and the wrong lane.
    expect(readerProse(CANADA_46AF4630)).toContain("clarify");
    expect(isListingQuestion({ subject: "Salem parade date", body: CANADA_46AF4630 })).toBe(false);
  });

  it("correction language wins even inside the template", () => {
    expect(isListingQuestion({ subject: SUBJ, body: `Is this date wrong?\n\n---\n${URL_J}` })).toBe(
      false
    );
    expect(isListingQuestion({ subject: "Incorrect Listing", body: PARADISE_F4A99FFB })).toBe(
      false
    );
  });

  it("needs BOTH halves — subject alone and our URL alone each read support at 0.90", () => {
    // subject, no URL of ours
    expect(
      isListingQuestion({ subject: SUBJ, body: "Can you rent wheelchairs at the festival?" })
    ).toBe(false);
    // our URL, but not our subject
    expect(isListingQuestion({ subject: "Hello", body: COREY_FBD5B1FC })).toBe(false);
    // a foreign URL with our subject — classifies `support`, never reaches here
    expect(
      isListingQuestion({
        subject: SUBJ,
        body: "Can you rent wheelchairs?\n\n---\nhttps://example.com/events/johnston",
      })
    ).toBe(false);
  });

  it("a Re: prefix does not hide the subject", () => {
    expect(isListingQuestion({ subject: `Re: Re: ${SUBJ}`, body: COREY_FBD5B1FC })).toBe(true);
  });

  it("our own quoted notification does not get to ask the question for the sender", () => {
    const quotedReply = [
      "The fair is the Waterford Worlds Fair",
      "",
      "> Why: no venue we have geocoded matched. Which fair are these from?",
      "> ---",
      `> ${URL_J}`,
    ].join("\n");
    expect(readerProse(quotedReply)).toBe("The fair is the Waterford Worlds Fair");
    expect(isListingQuestion({ subject: SUBJ, body: quotedReply })).toBe(false);
  });
});

describe("OPE-1085 — OPE-985's blank detection is untouched and still wins", () => {
  it("both real blank bodies are still blank, and are NOT listing questions", () => {
    for (const blank of [BLANK_6E713A8E, BLANK_1B72B1C3]) {
      expect(isBlankAskAboutEventBody(blank)).toBe(true);
      expect(readerProse(blank)).toBe("");
      expect(isListingQuestion({ subject: SUBJ, body: blank })).toBe(false);
    }
  });

  it("a client that re-indents the tail as `> ---` is still the blank template", () => {
    // Pins that readerProse dropping quoted lines did not break the OPE-985
    // detector, which must keep UNQUOTING rather than dropping.
    expect(isBlankAskAboutEventBody(BLANK_6E713A8E.replace("---", "> ---"))).toBe(true);
  });

  it("a real question is still captured in full, not stripped", () => {
    expect(readerProse(COREY_FBD5B1FC)).toBe("Can you rent wheelchairs at the festival?");
    expect(readerProse(KIMBERLEY_D062567B)).toBe(
      "Will it still be held in the rain today? -Kimberley"
    );
  });
});

// ---------------------------------------------------------------------------

const resolveHeldPhotosFromReply = vi.fn();
vi.mock("../src/photo/resolve-held-photos.js", () => ({
  resolveHeldPhotosFromReply: (...a: unknown[]) => resolveHeldPhotosFromReply(...a),
}));
const openObligationIfOwed = vi.fn();
vi.mock("../src/email-handlers/open-obligation.js", () => ({
  openObligationIfOwed: (...a: unknown[]) => openObligationIfOwed(...a),
}));

const inserted: Array<Record<string, unknown>> = [];
vi.mock("../src/db.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    }),
  }),
}));

const { handle } = await import("../src/email-handlers/correction.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CTX: any = { sessionId: "s-1", senderTrust: "unknown", emailAuth: "pass" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ENV: any = { DB: {} };

beforeEach(() => {
  resolveHeldPhotosFromReply.mockReset();
  resolveHeldPhotosFromReply.mockResolvedValue(null);
  openObligationIfOwed.mockReset();
  openObligationIfOwed.mockResolvedValue("obligation-1");
  inserted.length = 0;
});

describe("OPE-1085 — the handler branch", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = {
    id: "fbd5b1fc",
    subject: SUBJ,
    bodyTextExcerpt: COREY_FBD5B1FC,
    fromAddress: "cjlutzen71@gmail.com",
    receivedAt: 1758300006,
  };

  it("ACCEPTANCE: Corey does not receive copy asserting a correction was recorded", async () => {
    const out = await handle(ENV, CTX, row);
    expect(out.replyKind).not.toBe("correction-ack");
    expect(out.replyKind).toBe("support-ack");
    expect(out.status).toBe("replied");
  });

  it("scope 3 — it does not park on the correction lane's 7-day admin pause", async () => {
    const out = await handle(ENV, CTX, row);
    expect(out.skipAdminDecision).toBe(true);
  });

  it("the question is still owed an answer, and the obligation is the crossing", async () => {
    const out = await handle(ENV, CTX, row);
    expect(openObligationIfOwed).toHaveBeenCalledTimes(1);
    expect(out.crossingDestinationRef).toBe("obligation-1");
  });

  it("it is recorded as a listing question, NOT as a correction request", async () => {
    await handle(ENV, CTX, row);
    const actions = inserted.map((v) => v.action);
    expect(actions).toContain("email.listing_question");
    expect(actions).not.toContain("email.correction_request");
  });

  it("a real correction still gets the correction lane untouched", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const correctionRow: any = {
      id: "f4a99ffb",
      subject: "Incorrect Listing",
      bodyTextExcerpt: PARADISE_F4A99FFB,
      fromAddress: "ewelford@paradisecityarts.com",
      receivedAt: 1755100000,
    };
    // Tier 2 does a SELECT; the mocked db has no select, so assert on the
    // branch NOT taken by checking the action written before that point.
    await expect(handle(ENV, CTX, correctionRow)).rejects.toBeTruthy();
    expect(inserted.map((v) => v.action)).not.toContain("email.listing_question");
  });
});
