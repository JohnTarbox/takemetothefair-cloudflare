/**
 * OPE-845 — the flat /events/<slug> series hub must canonicalise to its current
 * edition's /year page (John's ruling 2026-09-30, option (a); implemented by
 * OPE-589 in `seriesHubCanonicalPath`).
 *
 * The OPE-589 test pins the FUNCTION. This pins the WIRING: the real
 * `buildEventMetadata` must route a series hub's `alternates.canonical` through
 * it. A function that is correct and no longer called would leave that test
 * green while the hub went back to declaring itself canonical, which is the
 * contradiction this ticket was filed for.
 *
 * Shape: Litchfield Fair, a series-backed fair whose occurrence carries a price
 * (the field the thin hub never rendered). Its 2026 edition is over, so the
 * canonical must move to 2027.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const landing = vi.fn();
vi.mock("@/lib/series/get-series-landing", () => ({
  getSeriesLanding: (slug: string) => landing(slug),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => ({}) }));

import { buildEventMetadata } from "../event-detail-data";

const occ = (year: number, month: string) => ({
  id: `litchfield-${year}`,
  slug: `litchfield-fair-${year}`,
  name: `Litchfield Fair ${year}`,
  startDate: new Date(`${year}-${month}T12:00:00Z`),
  endDate: new Date(`${year}-${month}T12:00:00Z`),
  venue: null,
  imageUrl: null,
  lifecycleStatus: "SCHEDULED",
  description: "Agricultural fair in Litchfield, ME.",
  ticketUrl: null,
  ticketPriceMinCents: 500,
  ticketPriceMaxCents: 1000,
});

function hub(occurrences: ReturnType<typeof occ>[]) {
  return {
    series: {
      canonicalSlug: "litchfield-fair",
      name: "Litchfield Fair",
      description: null, // the series row's NULL description from the ticket
      imageUrl: null,
      organizer: null,
    },
    occurrences,
  };
}

afterEach(() => {
  vi.useRealTimers();
  landing.mockReset();
});

describe("OPE-845 buildEventMetadata — a series hub canonicalises to its /year page", () => {
  it("after the 2026 edition, the hub's canonical is /2027, not itself", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
    landing.mockResolvedValue(hub([occ(2026, "09-11"), occ(2027, "09-10")]));
    const meta = await buildEventMetadata("litchfield-fair");
    expect(meta.alternates?.canonical).toBe(
      "https://meetmeatthefair.com/events/litchfield-fair/2027"
    );
  });

  it("before the edition, the canonical is that edition's year", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-07T12:00:00Z"), toFake: ["Date"] });
    landing.mockResolvedValue(hub([occ(2026, "09-11"), occ(2027, "09-10")]));
    const meta = await buildEventMetadata("litchfield-fair");
    expect(meta.alternates?.canonical).toBe(
      "https://meetmeatthefair.com/events/litchfield-fair/2026"
    );
  });

  it("never declares the bare hub URL canonical while a dated edition exists", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
    landing.mockResolvedValue(hub([occ(2026, "09-11")]));
    const meta = await buildEventMetadata("litchfield-fair");
    expect(meta.alternates?.canonical).not.toBe(
      "https://meetmeatthefair.com/events/litchfield-fair"
    );
  });
});
