/**
 * OPE-740 — a projected date must not claim to be a submitted one.
 *
 * The card's hedged tooltip read "Dates as submitted — not yet confirmed with
 * the organizer". On a rolled-forward row that is **false in our favour**:
 * nobody submitted the date, we generated it by shifting last year's. It
 * asserted MORE than the truth, on 124 publicly indexed pages, 122 of which
 * have nothing attesting the date at all.
 *
 * Measured 2026-09-06: 121 `annual_rollover` rows + 3 `manual_rollover`, and
 * `rolled_from_event_id` is non-NULL on **zero rows in the whole table** —
 * so the 121-row cohort can only be recognised by `ingestion_method`.
 */
import { describe, expect, it } from "vitest";
import {
  DERIVED_DATE_EXPLANATION,
  DERIVED_DATE_SHORT,
  ROLLOVER_INGESTION_METHODS,
  hasDerivedDate,
  shouldShowProjectedDateCopy,
} from "../derived-date";

describe("both cohorts are recognised", () => {
  it("the 121-row offline cohort, which recorded no lineage", () => {
    expect(hasDerivedDate({ ingestionMethod: "annual_rollover", rolledFromEventId: null })).toBe(
      true
    );
  });

  it("the live path, which sets the FK", () => {
    expect(hasDerivedDate({ ingestionMethod: "auto_rollover", rolledFromEventId: "evt-1" })).toBe(
      true
    );
  });

  it("either tell ALONE is enough — this is why it is an OR", () => {
    // ⚠️ A gate keyed on one covers one cohort and silently misses the other.
    // The offline cohort has no FK; a future path might set the FK under an
    // ingestion method nobody added to the list.
    expect(hasDerivedDate({ ingestionMethod: "annual_rollover" })).toBe(true);
    expect(hasDerivedDate({ ingestionMethod: "web_research", rolledFromEventId: "evt-9" })).toBe(
      true
    );
  });

  it("a manual rollover is still a projection", () => {
    // An operator shifting last year's dates by hand produces the same claim.
    expect(hasDerivedDate({ ingestionMethod: "manual_rollover" })).toBe(true);
  });
});

describe("a genuinely submitted date is NOT flagged", () => {
  it("the ordinary sourced methods pass through", () => {
    // The positive landmark. A predicate returning true for everything would
    // satisfy every assertion above, and would put "we projected this" on
    // pages where an organizer really did tell us.
    for (const m of [
      "vendor_submission",
      "email_submission",
      "direct_scrape",
      "admin_manual",
      "web_research",
      "discovery",
      "community_suggestion",
      "aggregator_import",
    ]) {
      expect(hasDerivedDate({ ingestionMethod: m, rolledFromEventId: null })).toBe(false);
    }
  });

  it("empty, null and missing inputs are not derived", () => {
    expect(hasDerivedDate(null)).toBe(false);
    expect(hasDerivedDate(undefined)).toBe(false);
    expect(hasDerivedDate({})).toBe(false);
    expect(hasDerivedDate({ ingestionMethod: null, rolledFromEventId: null })).toBe(false);
    // An empty-string FK is not a link.
    expect(hasDerivedDate({ rolledFromEventId: "" })).toBe(false);
  });

  it("origin is NOT keyed on dates_confirmed", () => {
    // hasDerivedDate answers "was this born as a projection", which does not
    // change when someone later confirms the date. That is the right basis for
    // SCOPING. It is not the right basis for the copy — see the block below.
    expect(hasDerivedDate({ ingestionMethod: "annual_rollover" })).toBe(true);
  });
});

describe("the copy says what is true", () => {
  it("does not claim anyone submitted anything", () => {
    // The whole defect in one assertion.
    for (const copy of [DERIVED_DATE_EXPLANATION, DERIVED_DATE_SHORT]) {
      expect(copy.toLowerCase()).not.toContain("submitted");
      expect(copy.toLowerCase()).not.toContain("as provided");
    }
  });

  it("states the origin and the gap", () => {
    expect(DERIVED_DATE_EXPLANATION.toLowerCase()).toContain("projected");
    expect(DERIVED_DATE_EXPLANATION.toLowerCase()).toContain("last year");
    expect(DERIVED_DATE_EXPLANATION.toLowerCase()).toContain("not published");
    expect(DERIVED_DATE_SHORT.toLowerCase()).toContain("projected");
  });

  it("the method list covers every rollover method present in prod", () => {
    // Positive landmark on the list itself: a shrunken list would make the
    // cohort tests above pass vacuously for whatever it still contained.
    expect([...ROLLOVER_INGESTION_METHODS].sort()).toEqual([
      "annual_rollover",
      "auto_rollover",
      "manual_rollover",
    ]);
  });
});

describe("shouldShowProjectedDateCopy — a later confirmation supersedes the projection", () => {
  it("⚠️ a rolled row that was SINCE confirmed gets no projection copy", () => {
    // The two live specimens. Both created 2026-06-15 by the rollover, both
    // later cited against an official_website source on start_date AND
    // end_date — Litchfield to maine.gov's 2026-2029 schedule (2026-08-29),
    // Martha's Vineyard to the Agricultural Society (2026-08-17).
    //
    // The first version shipped told a reader of the Litchfield page "the
    // organizer has not published them yet" while we held a State of Maine
    // citation for exactly those dates. The original defect, inverted.
    expect(
      shouldShowProjectedDateCopy({ ingestionMethod: "annual_rollover", datesConfirmed: true })
    ).toBe(false);
    // D1 stores the flag as an integer; accept both representations.
    expect(
      shouldShowProjectedDateCopy({ ingestionMethod: "annual_rollover", datesConfirmed: 1 })
    ).toBe(false);
  });

  it("an UNCONFIRMED rolled row still gets it — all 122 of them", () => {
    // Positive landmark. A predicate that always returned false would satisfy
    // the case above and silently un-hedge every page this ticket is about.
    for (const c of [false, 0, null, undefined]) {
      expect(
        shouldShowProjectedDateCopy({ ingestionMethod: "annual_rollover", datesConfirmed: c })
      ).toBe(true);
    }
    expect(shouldShowProjectedDateCopy({ rolledFromEventId: "evt-1" })).toBe(true);
  });

  it("a confirmed NON-rolled row is still not a projection", () => {
    // The flag must not be able to turn an ordinary event INTO one.
    expect(
      shouldShowProjectedDateCopy({ ingestionMethod: "email_submission", datesConfirmed: false })
    ).toBe(false);
  });

  it("⚠️ scope and copy stay different questions", () => {
    // hasDerivedDate must keep counting the confirmed rows, or the attestation
    // classifier's `attested: 2` bucket silently becomes 0 and the population
    // it reports drops to 122 — losing exactly the rows worth watching.
    const confirmed = { ingestionMethod: "annual_rollover", datesConfirmed: true };
    expect(hasDerivedDate(confirmed)).toBe(true);
    expect(shouldShowProjectedDateCopy(confirmed)).toBe(false);
  });
});
