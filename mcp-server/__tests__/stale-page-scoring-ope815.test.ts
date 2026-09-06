/**
 * OPE-815 (GATE-NOISE G5) — what a stale-page finding is evidence OF.
 *
 * Every fixture is one of the analyst's hand-verified rows from 2026-09-05:
 *
 *   nrtofeaston.org         page reads "Sunday, October 5, 2025"; event 2026-10-04  TRUE
 *   worcestercraftcenter.org page reads "Nov 29 – Dec 1, 2024" (site © 2026)         TRUE
 *   jenksproductions.com     page now reads "November 15, 2026" — matches us         FALSE
 *
 * 2 of 3 organizer-domain findings were real. All 15 aggregator findings are
 * where the noise lives, including four rows that are the SAME recurring series
 * matched to different occurrences — an internal series-matching problem
 * reported as an external date conflict.
 */
import { describe, expect, it } from "vitest";
import {
  classifyComparisonTarget,
  isPriorYearDrift,
  stalePageConfidence,
} from "../src/goodwill/stale-page-scoring.js";

describe("who are we disagreeing with", () => {
  it("the organizer's own domain is `organizer`", () => {
    expect(
      classifyComparisonTarget("https://nrtofeaston.org/events/fall", "https://nrtofeaston.org")
    ).toBe("organizer");
    // www., scheme and trailing-dot differences must not split a host.
    expect(
      classifyComparisonTarget("https://www.worcestercraftcenter.org/x", "worcestercraftcenter.org")
    ).toBe("organizer");
  });

  it("a subdomain of the organizer is still the organizer", () => {
    expect(classifyComparisonTarget("https://events.example.org/a", "https://example.org")).toBe(
      "organizer"
    );
  });

  it("the three real aggregators are `aggregator`", () => {
    for (const host of ["capecodchamber.org", "visitrhodeisland.com", "visitaroostook.com"]) {
      expect(classifyComparisonTarget(`https://${host}/event/123`, "https://realfair.org")).toBe(
        "aggregator"
      );
    }
  });

  it("⚠️ no promoter website on file is `unknown`, never `organizer`", () => {
    // We only claim a page is the promoter's when we can show it. A finding we
    // cannot attribute must not become an email.
    expect(classifyComparisonTarget("https://somewhere.org/x", null)).toBe("unknown");
    expect(classifyComparisonTarget("https://somewhere.org/x", "")).toBe("unknown");
    expect(classifyComparisonTarget(null, "https://realfair.org")).toBe("unknown");
  });

  it("unparseable input degrades to unknown rather than throwing", () => {
    expect(classifyComparisonTarget("not a url", "also not a url")).toBe("unknown");
  });
});

describe("a ~1 or ~2 year drift is its own category, not the top of a scale", () => {
  it("catches the observed 364 / 366 / 729 day drifts", () => {
    for (const d of [364, 365, 366, 729, 730]) expect(isPriorYearDrift(d)).toBe(true);
  });

  it("allows slack for annual events that move to the nearest weekend", () => {
    // "First Saturday in October" lands 364, 365 or 371 days later by year.
    expect(isPriorYearDrift(371)).toBe(true);
    expect(isPriorYearDrift(358)).toBe(true);
  });

  it("does NOT swallow ordinary drift", () => {
    // Positive landmark: a predicate that returned true for everything would
    // satisfy every assertion above.
    for (const d of [2, 4, 8, 10, 15, 16, 30, 90, 200]) expect(isPriorYearDrift(d)).toBe(false);
  });
});

describe("confidence answers 'is OUR date wrong', not 'how far apart are they'", () => {
  it("⚠️ inverts the two cases the old formula got backwards", () => {
    // Old: Math.min(1, |drift|/30). A 729-day drift on an aggregator scored
    // 1.0 — the maximum — while a 2-day drift scored 0.067.
    const aggregatorPriorYear = stalePageConfidence(729, "aggregator");
    const aggregatorSmall = stalePageConfidence(2, "aggregator");

    // The prior-year aggregator row used to top the queue. It now sits below
    // the small-drift one, because it says almost nothing about our data.
    expect(aggregatorPriorYear).toBeLessThan(aggregatorSmall);
    expect(aggregatorPriorYear).toBeLessThan(0.2);
  });

  it("the organizer-with-prior-year case ranks highest — the only safe email", () => {
    // The claim is purely about THEIR page, so it holds whether or not our own
    // date is right. That matters when 421 upcoming events assert
    // dates_confirmed with no citation.
    const best = stalePageConfidence(366, "organizer");
    expect(best).toBeGreaterThan(stalePageConfidence(366, "aggregator"));
    expect(best).toBeGreaterThan(stalePageConfidence(2, "organizer"));
    expect(best).toBeGreaterThan(stalePageConfidence(366, "unknown"));
  });

  it("an organizer disagreement always outranks the same drift on an aggregator", () => {
    for (const d of [2, 15, 90, 365, 729]) {
      expect(stalePageConfidence(d, "organizer")).toBeGreaterThan(
        stalePageConfidence(d, "aggregator")
      );
    }
  });

  it("the off-by-one family is no longer near-invisible", () => {
    // A 2-day drift is the OPE-307 timezone signature and scored 0.067 before.
    expect(stalePageConfidence(2, "aggregator")).toBeGreaterThan(0.067);
    expect(stalePageConfidence(2, "organizer")).toBeGreaterThan(0.5);
  });

  it("every score stays inside 0..1", () => {
    for (const t of ["organizer", "aggregator", "unknown"] as const) {
      for (const d of [0, 1, 2, 30, 364, 730, 5000]) {
        const c = stalePageConfidence(d, t);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});
