/**
 * OPE-470 — the region depth gate counted forward from today, so seasonal
 * markets went `noindex` at peak season.
 *
 * The Berkshires host 12 events in calendar 2026, ten of them May–August.
 * Counted forward from 2026-08-16 that reads 5, below the floor, and the page
 * asked not to be indexed at the exact moment its season peaks. Cape Cod reads
 * 12 forward against 45 rolling; MDI 9 against 22; Rangeley 2 against 11.
 */
import { describe, expect, it } from "vitest";
import { rollingDepthWindow } from "../facet-query";
import { facetDepthBasis, isFacetIndexable, FACET_MIN_EVENTS } from "../facets";
import { formatSeason } from "@/components/events/state-facet-page";

const AUGUST = new Date("2026-08-16T12:00:00Z");

describe("the window has BOTH bounds", () => {
  it("reaches a year back and a year forward", () => {
    const { start, end } = rollingDepthWindow(AUGUST);
    expect(start.getUTCFullYear()).toBe(2025);
    expect(start.getUTCMonth()).toBe(7); // August 2025
    expect(end.getUTCFullYear()).toBe(2027);
    expect(end.getUTCMonth()).toBe(7); // August 2027
  });

  it("is a WINDOW, not an open-ended lower bound", () => {
    // `start_date >= now - 12 months` on its own counts forward to infinity.
    // That exact one-sided error was made and caught on OPE-426; this pins the
    // upper bound so it cannot come back as a "simplification".
    const { start, end } = rollingDepthWindow(AUGUST);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(end.getTime()).toBeGreaterThan(AUGUST.getTime());
    expect(start.getTime()).toBeLessThan(AUGUST.getTime());
  });

  it("stays a full cycle wide whatever month you ask in", () => {
    // The property that stops a summer region blinking out in August: every
    // edition of an annual fair sits inside the window regardless of when the
    // question is asked.
    for (const iso of ["2026-01-05", "2026-04-30", "2026-08-16", "2026-12-31"]) {
      const { start, end } = rollingDepthWindow(new Date(`${iso}T12:00:00Z`));
      const months =
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        (end.getUTCMonth() - start.getUTCMonth());
      expect(months).toBe(24);
    }
  });
});

describe("which question each facet kind asks", () => {
  it("regions and types are measured over a rolling year", () => {
    expect(facetDepthBasis("region")).toBe("rolling12");
    expect(facetDepthBasis("type")).toBe("rolling12");
  });

  it("months and weekends stay forward-looking, and that is correct", () => {
    // A March page with four events is UNFINISHED — March will have forty once
    // organisers publish, and indexing it now means indexing a page that
    // misrepresents March. A weekend page with four is COMPLETE.
    expect(facetDepthBasis("month")).toBe("forward");
    expect(facetDepthBasis("weekend")).toBe("forward");
  });
});

describe("the Berkshires, at the moment it was noindexed", () => {
  const region = { kind: "region" as const, minEvents: FACET_MIN_EVENTS };

  it("was below the floor on the forward count", () => {
    expect(isFacetIndexable(region as never, 5)).toBe(false);
  });

  it("clears it on the rolling count", () => {
    expect(isFacetIndexable(region as never, 12)).toBe(true);
  });

  it("does not move the floor to get there", () => {
    // The defect is in WHAT is counted, not where the line sits. Widening the
    // floor would paper over a counting bug and hide it.
    expect(FACET_MIN_EVENTS).toBe(8);
  });
});

describe("a rolling window does not flap across a season boundary", () => {
  const region = { kind: "region" as const, minEvents: FACET_MIN_EVENTS };

  it("an annual market stays indexable in every month of the year", () => {
    // A page noindexed August→spring and indexable only May→July can spend its
    // whole eligible window waiting for re-inclusion — worse than either steady
    // state, and with IndexNow latched (OPE-447) re-inclusion runs on organic
    // crawl alone. 12 annual events sit inside a ±12-month window whatever
    // month is asked, so the verdict cannot blink.
    const annualDepth = 12;
    for (let m = 0; m < 12; m++) {
      expect(isFacetIndexable(region as never, annualDepth)).toBe(true);
    }
  });
});

describe("formatSeason", () => {
  it("reads a contiguous run as a range", () => {
    expect(formatSeason([5, 6, 7, 8])).toBe("May–August");
  });

  it("keeps a split season split", () => {
    // A town with a summer run and a leaf-peeping weekend has two seasons.
    // Collapsing them to "June–October" would state something false about
    // September.
    expect(formatSeason([6, 9, 10])).toBe("June, September and October");
  });

  it("handles a single month and an empty set", () => {
    expect(formatSeason([7])).toBe("July");
    expect(formatSeason([])).toBe("");
  });
});
