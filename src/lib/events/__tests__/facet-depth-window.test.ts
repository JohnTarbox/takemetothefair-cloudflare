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

/**
 * OPE-470 scope 4 — hysteresis, decided by measurement rather than argument.
 *
 * The previous version of this block looped twelve times over
 * `isFacetIndexable(region, 12)` with a CONSTANT depth. The loop could not fail:
 * nothing moved between iterations, so it asserted the same expression twelve
 * times and proved nothing about a season boundary. That is precisely the
 * "scored as an argument" the 08-20 review objected to.
 *
 * These slide a real clock over real event dates through the real
 * `rollingDepthWindow`, so a one-sided or too-narrow window makes them fail.
 */
function depthAt(dates: readonly Date[], now: Date): number {
  const { start, end } = rollingDepthWindow(now);
  return dates.filter((d) => d >= start && d < end).length;
}

/** `n` events every summer, for each listed year — a seasonal market. */
function seasonalMarket(years: readonly number[], perYear: number): Date[] {
  const out: Date[] = [];
  for (const y of years) {
    for (let i = 0; i < perYear; i++) {
      // Spread May–August, the shape the Berkshires actually has.
      const month = 5 + (i % 4);
      out.push(new Date(Date.UTC(y, month - 1, 10 + (i % 15), 12)));
    }
  }
  return out;
}

/** Every month-start from `from` through `to`, inclusive. */
function monthlyClock(from: string, to: string): Date[] {
  const out: Date[] = [];
  const end = new Date(to);
  for (const d = new Date(from); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    out.push(new Date(d));
  }
  return out;
}

describe("a rolling window does not flap across a season boundary", () => {
  const region = { kind: "region" as const, minEvents: FACET_MIN_EVENTS };
  const clock = monthlyClock("2026-01-01T12:00:00Z", "2027-12-01T12:00:00Z");

  it("a summer-only market stays indexable in EVERY month, with the clock moving", () => {
    // The reported defect: a page noindexed August→spring and indexable only
    // May–July can spend its whole eligible window waiting for re-inclusion —
    // worse than either steady state, and with IndexNow latched (OPE-447)
    // re-inclusion runs on organic crawl alone.
    const dates = seasonalMarket([2025, 2026, 2027, 2028], 12);
    const verdicts = clock.map((now) => isFacetIndexable(region as never, depthAt(dates, now)));

    expect(verdicts).toHaveLength(24);
    expect(verdicts.every((v) => v === true)).toBe(true);
  });

  it("the FORWARD count it replaced DOES flap on the real Berkshires shape", () => {
    // The control, and getting it right is the whole finding.
    //
    // A market whose next season is already published does NOT expose the bug —
    // a forward window still contains a full season. The Berkshires' actual
    // shape is that next season is NOT published yet: measured in prod
    // 2026-08-23, 9 of its 10 in-window events are TRAILING and exactly 1 is
    // forward. Organisers publish in spring, so for most of the year the
    // catalogue holds the season that just happened.
    //
    // So the control models that: editions exist through the current year only.
    const dates = seasonalMarket([2025, 2026], 12);
    const thisYear = monthlyClock("2026-01-01T12:00:00Z", "2026-12-01T12:00:00Z");

    const forward = thisYear.map((now) =>
      isFacetIndexable(region as never, countForward(dates, now))
    );
    const rolling = thisYear.map((now) => isFacetIndexable(region as never, depthAt(dates, now)));

    // The old basis blinks as the season drains away…
    expect(new Set(forward).size).toBeGreaterThan(1);
    expect(forward.some((v) => v === false)).toBe(true);
    // …while the rolling window holds it steady. Same data, same clock.
    expect(new Set(rolling).size).toBe(1);
    expect(rolling[0]).toBe(true);
  });

  it("a genuinely thin market stays noindex all year — the gate still says no", () => {
    // A rolling window must not simply make everything indexable. `south-coast`
    // is the live proof (5 upcoming, noindex, while the Berkshires' 5 upcoming
    // is indexable); this is the same property under test.
    const dates = seasonalMarket([2025, 2026, 2027, 2028], 3);
    const verdicts = clock.map((now) => isFacetIndexable(region as never, depthAt(dates, now)));
    expect(verdicts.every((v) => v === false)).toBe(true);
  });

  it("a market sitting EXACTLY on the floor does not blink month to month", () => {
    // The residual scope-4 asked about: seasonal flapping is removed by the
    // window's construction, but a market hovering at the floor could in
    // principle still oscillate as editions age out. Measured rather than
    // argued — and if this ever fails, that is the evidence that hysteresis
    // (persisted prior state) is genuinely needed rather than merely requested.
    const dates = seasonalMarket([2025, 2026, 2027, 2028], FACET_MIN_EVENTS);
    const verdicts = clock.map((now) => isFacetIndexable(region as never, depthAt(dates, now)));

    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe(true);
  });
});

/** Forward-only depth — the basis this ticket replaced, kept solely so the
 *  control test above can show it flapping. */
function countForward(dates: readonly Date[], now: Date): number {
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 12);
  return dates.filter((d) => d >= now && d < end).length;
}

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

/**
 * OPE-470 scope 3 — the empty-window content contract.
 *
 * The 08-20 review asked to "confirm `getFacetSeasonality` reads the same
 * rolling window the gate counted." It must: a page that says "hosts 12 events
 * a year" while the gate indexed it on a different count is a page making a
 * claim nothing verified.
 *
 * Asserted against the source because the function needs a D1 handle. Anchored
 * on the CALL syntax, not the bare symbol — a bare-symbol search matches the
 * import line and the assertion goes vacuously green.
 */
describe("the seasonality copy is drawn from the gate's own window", () => {
  it("getFacetSeasonality calls rollingDepthWindow, like countFacetDepth does", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source: string = readFileSync(resolve(__dirname, "..", "facet-query.ts"), "utf8");

    const fn = source.slice(source.indexOf("export async function getFacetSeasonality"));
    const body = fn.slice(0, fn.indexOf("\nexport "));

    expect(body).toContain("rollingDepthWindow(now)");
    // It must not quietly compute its own bounds.
    expect(body).not.toMatch(/setUTCMonth/);
  });

  it("renders only when the forward list is empty, so a populated page pays nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const page: string = readFileSync(
      resolve(__dirname, "..", "..", "..", "components", "events", "state-facet-page.tsx"),
      "utf8"
    );

    // The gate on the query…
    expect(page).toMatch(/eventsList\.length === 0\s*\?\s*await getFacetSeasonality/);
    // …and on the render. `total > 0` is what stops a genuinely empty facet
    // (a month with no events at all) from claiming a season it does not have.
    expect(page).toMatch(/seasonality && seasonality\.total > 0/);
  });
});
