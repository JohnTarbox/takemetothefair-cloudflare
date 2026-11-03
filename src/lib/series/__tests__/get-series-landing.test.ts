/**
 * OPE-210 — the empty-hub guard.
 *
 * A series whose occurrences are all non-public used to render a full,
 * self-canonical, indexable 200 hub listing zero events (31 such pages in prod
 * on 2026-07-15). It must now return null so the callers fall through to their
 * existing notFound() path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// React's `cache()` is a server-runtime API and isn't callable under vitest —
// which is why this module had no test before. Identity-stub it so the module
// imports; per-call memoization isn't what we're testing here.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

const seriesRows = vi.fn();
const occurrenceRows = vi.fn();
const dayRows = vi.fn(() => Promise.resolve([] as unknown[]));

// getSeriesLanding selects the series row (with .limit(1)), then its public
// occurrences, then (OPE-1547) the occurrences' event_days in chunks of 50.
// Hand back each in turn.
let call = 0;
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => {
    const chain = {
      select: () => chain,
      from: () => chain,
      leftJoin: () => chain,
      where: () => {
        // First `where` resolves the series lookup (it chains .limit);
        // the second resolves the occurrence rows; any later one is day rows.
        call += 1;
        if (call === 1) return { limit: async () => seriesRows() };
        if (call === 2) return occurrenceRows() as unknown;
        return dayRows() as unknown;
      },
    };
    return chain;
  },
  getCloudflareEnv: () => ({}),
}));

const { getSeriesLanding } = await import("../get-series-landing");

const SERIES = {
  id: "s1",
  canonicalSlug: "fryeburg-fair",
  name: "Fryeburg Fair",
  description: "A fair.",
  imageUrl: null,
  promoterCompanyName: null,
  promoterWebsite: null,
  promoterLogoUrl: null,
};

const OCCURRENCE = {
  id: "e1",
  slug: "fryeburg-fair-2026",
  name: "Fryeburg Fair 2026",
  startDate: new Date("2026-10-04T00:00:00Z"),
  endDate: new Date("2026-10-05T00:00:00Z"),
  imageUrl: null,
  lifecycleStatus: "SCHEDULED",
  description: null,
  ticketUrl: null,
  ticketPriceMinCents: null,
  ticketPriceMaxCents: null,
  venueName: "Fryeburg Fairgrounds",
  venueAddress: "1154 Main St",
  venueCity: "Fryeburg",
  venueState: "ME",
  venueZip: "04037",
  venueLat: 44.0176,
  venueLng: -70.9803,
  venueTimezone: "America/New_York",
};

beforeEach(() => {
  call = 0;
  vi.clearAllMocks();
  // React `cache()` memoizes per slug — vary the slug per test to avoid reuse.
});

describe("getSeriesLanding — OPE-210 empty-hub guard", () => {
  it("returns null when the series has NO public occurrence", async () => {
    seriesRows.mockReturnValue([{ ...SERIES, canonicalSlug: "empty-hub-a" }]);
    occurrenceRows.mockReturnValue(Promise.resolve([]));
    // The whole point: an empty series must not render an indexable 200.
    expect(await getSeriesLanding("empty-hub-a")).toBeNull();
  });

  it("still returns a landing when the series HAS a public occurrence", async () => {
    seriesRows.mockReturnValue([{ ...SERIES, canonicalSlug: "live-hub-b" }]);
    occurrenceRows.mockReturnValue(Promise.resolve([OCCURRENCE]));
    const landing = await getSeriesLanding("live-hub-b");
    expect(landing).not.toBeNull();
    expect(landing?.occurrences).toHaveLength(1);
    expect(landing?.series.name).toBe("Fryeburg Fair");
  });

  it("returns null when the series row itself does not exist", async () => {
    seriesRows.mockReturnValue([]);
    occurrenceRows.mockReturnValue(Promise.resolve([]));
    expect(await getSeriesLanding("no-such-series-c")).toBeNull();
  });
});

describe("getSeriesLanding — OPE-1547 day rows for the JSON-LD dates", () => {
  it("attaches each occurrence's own event_days and its venue zone", async () => {
    seriesRows.mockReturnValue([{ ...SERIES, canonicalSlug: "days-hub-d" }]);
    occurrenceRows.mockReturnValue(
      Promise.resolve([OCCURRENCE, { ...OCCURRENCE, id: "e2", slug: "fryeburg-fair-2027" }])
    );
    dayRows.mockReturnValueOnce(
      Promise.resolve([
        { eventId: "e1", date: "2026-10-04", openTime: "08:00", closeTime: "22:00", closed: false },
      ])
    );
    const landing = await getSeriesLanding("days-hub-d");
    const [e1, e2] = landing!.occurrences;
    expect(e1.eventDays).toEqual([
      { date: "2026-10-04", openTime: "08:00", closeTime: "22:00", closed: false },
    ]);
    expect(e2.eventDays).toEqual([]);
    expect(e1.venueTimezone).toBe("America/New_York");
    // One day-rows query for two occurrences (well under the 50-id chunk).
    expect(dayRows).toHaveBeenCalledTimes(1);
  });
});
