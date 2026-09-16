/**
 * OPE-465 — the grounding verifier, tested against the submissions that
 * produced the ticket.
 *
 * The three specimens are quoted from the ticket, which quoted the inbound
 * rows. They are the whole point: each value is plausible, none is a parse
 * error, and the only thing wrong with any of them is that no source says it.
 *
 * The second half of this file matters as much as the first. OPE-459 defect 3
 * is the live example of a gate tuned too tight — five real prose-named events
 * collapsed into one `TBD` row — so every rule here is pinned from BOTH sides:
 * what it must drop, and what it must leave alone.
 */
import { describe, it, expect } from "vitest";
import {
  groundEventDates,
  decideEventGrounding,
  sourceNamesDay,
  sourceStatesDetailsForthcoming,
  isWholeMonthSpan,
  groundingConfidence,
} from "../field-grounding";

/** The Waterville Elks email, verbatim from the OPE-378/465 record. */
const ELKS =
  "Waterville Elks Lodge #905 is currently seeking crafters for their annual craft fair on Sunday, November 1, 2026. Email secretary@waterville905.com for application. This is our 28th Annual event that draws hundreds of shoppers and the 65-table venue will fill up fast. Contact us today!";

/** The flyer the Nov 1–30 span was extracted from: a ONE-DAY fair on Nov 7. */
const NOV_7_FLYER =
  "Holiday Craft Fair — Saturday, November 7, 2026, 9am to 2pm. Free admission. 40 tables of local crafters at the community center.";

/** The UMF email, verbatim. */
const UMF =
  "Thank you for your interest. Information regarding the December Craft Fair will be sent out later this year.";

/** The "MV 2" body: one URL, no dates anywhere. */
const URL_ONLY = "https://vineyardartisans.com/festivals/";

describe("the three specimens", () => {
  it("drops the manufactured Nov 1 → Nov 30 span, naming the day the source DID state", () => {
    const d = decideEventGrounding({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      sources: [NOV_7_FLYER],
    });
    expect(d.dropFields).toEqual(["start_date", "end_date"]);
    expect(d.reason).toContain("2026-11-07");
    expect(d.refuseCreate).toBe(false); // the event is real; its dates are not
  });

  it("refuses to create an event from a sentence saying the details do not exist yet", () => {
    const d = decideEventGrounding({ startDate: null, endDate: null, sources: [UMF] });
    expect(d.refuseCreate).toBe(true);
    expect(d.reason).toContain("not available yet");
  });

  it("drops a date cited to a body that contains no dates at all", () => {
    const d = decideEventGrounding({
      startDate: "2024-06-15",
      endDate: null,
      sources: [URL_ONLY],
    });
    expect(d.dropFields).toEqual(["start_date"]);
  });
});

describe("what it must NOT touch — the recall half", () => {
  it("keeps a date the source states outright", () => {
    const [start] = groundEventDates({ startDate: "2026-11-01", sources: [ELKS] });
    expect(start.verdict).toBe("supported");
    expect(start.span).toContain("November 1");
  });

  it("keeps the Nov 7 fair's own date, which is the same submission that failed above", () => {
    const d = decideEventGrounding({
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      sources: [NOV_7_FLYER],
    });
    expect(d.dropFields).toEqual([]);
    expect(d.refuseCreate).toBe(false);
  });

  it("keeps a real multi-day run the source states at both ends", () => {
    const src = "The fair runs August 21 through August 24, 2026 at the fairgrounds.";
    const d = decideEventGrounding({
      startDate: "2026-08-21",
      endDate: "2026-08-24",
      sources: [src],
    });
    expect(d.dropFields).toEqual([]);
  });

  it("keeps a genuine whole-month run when the source states both ends", () => {
    // The whole-month rule keys on the ends being UNSTATED, not on the shape.
    const src = "Open daily from November 1 to November 30, 2026.";
    expect(isWholeMonthSpan("2026-11-01", "2026-11-30")).toBe(true);
    expect(
      decideEventGrounding({ startDate: "2026-11-01", endDate: "2026-11-30", sources: [src] })
        .dropFields
    ).toEqual([]);
  });

  it("an event with no date and no 'forthcoming' sentence is still created", () => {
    // This site accepts undated submissions every week. Refusal needs BOTH
    // halves, or the gate becomes a recall regression.
    const d = decideEventGrounding({
      startDate: null,
      endDate: null,
      sources: ["Annual craft fair at the Elks Lodge. Crafters wanted."],
    });
    expect(d.refuseCreate).toBe(false);
  });

  it("with NO source text captured, nothing is dropped — a fetch failure is not a data-loss event", () => {
    const d = decideEventGrounding({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      sources: [null, "", undefined],
    });
    expect(d.dropFields).toEqual([]);
    expect(d.results[0].verdict).toBe("supported");
    expect(d.results[0].reason).toContain("no source text");
  });

  it("a month named but not the day is PARTIAL — kept, with lower confidence", () => {
    const [start] = groundEventDates({
      startDate: "2026-12-05",
      sources: ["Our December craft fair returns this year."],
    });
    expect(start.verdict).toBe("partial");
    expect(groundingConfidence(start.verdict)).toBe(0.5);
  });
});

describe("sourceNamesDay — the date shapes organizers actually write", () => {
  it.each([
    ["November 7, 2026", "2026-11-07"],
    ["Nov. 7th", "2026-11-07"],
    ["Nov 7", "2026-11-07"],
    ["7 November", "2026-11-07"],
    ["11/7/2026", "2026-11-07"],
    ["11-07", "2026-11-07"],
    ["2026-11-07", "2026-11-07"],
  ])("finds %s", (text, iso) => {
    expect(sourceNamesDay(iso, `The fair is on ${text} at the hall.`).hit).toBe(true);
  });

  it("does not let a longer number satisfy a shorter day", () => {
    // `Nov 70` must not read as `Nov 7`, and 11/70 must not read as 11/7.
    expect(sourceNamesDay("2026-11-07", "call 508.693.9549 or see Nov 70").hit).toBe(false);
    expect(sourceNamesDay("2026-01-07", "invoice 11/70").hit).toBe(false);
  });

  it("does not match a different day in the same month", () => {
    expect(sourceNamesDay("2026-11-01", NOV_7_FLYER).hit).toBe(false);
    expect(sourceNamesDay("2026-11-07", NOV_7_FLYER).hit).toBe(true);
  });
});

describe("sourceStatesDetailsForthcoming", () => {
  it("catches the UMF sentence and the common variants", () => {
    for (const s of [
      UMF,
      "Details are forthcoming.",
      "Dates will be announced soon.",
      "More information later this spring.",
      "Application will be posted in the fall.",
    ]) {
      expect(sourceStatesDetailsForthcoming([s]).stated, s).toBe(true);
    }
  });

  it("does not fire on an ordinary listing that happens to use the word 'information'", () => {
    for (const s of [
      "For information email secretary@waterville905.com.",
      ELKS,
      NOV_7_FLYER,
      "Vendor applications are open now; the fair is November 7.",
    ]) {
      expect(sourceStatesDetailsForthcoming([s]).stated, s).toBe(false);
    }
  });

  it("returns the span it matched, so an operator can see what it read", () => {
    const r = sourceStatesDetailsForthcoming([UMF]);
    expect(r.span).toContain("will be sent out");
  });
});

describe("groundingConfidence — the verdict IS the number", () => {
  it("varies by verdict and is null when there is no verdict", () => {
    expect(groundingConfidence("supported")).toBe(0.95);
    expect(groundingConfidence("partial")).toBe(0.5);
    expect(groundingConfidence("unsupported")).toBe(0);
    expect(groundingConfidence(undefined)).toBeNull();
  });

  it("is never the 0.6 that OPE-457 measured as a constant", () => {
    // 0.6 was `medium`, and `medium` was "no JSON-LD on the page" — a property
    // of the page's markup, not a measurement of the value.
    for (const v of ["supported", "partial", "unsupported", undefined] as const) {
      expect(groundingConfidence(v)).not.toBe(0.6);
    }
  });
});
