/**
 * K50 — the new Bing client wrappers (getTrafficStats / getBacklinks /
 * getCrawledUrls). Stubs global fetch with a Bing JSON envelope and asserts the
 * defensive row-mapping (field extraction, date parsing, count defaulting, and
 * graceful empty handling). Env has no RATE_LIMIT_KV so the cache is bypassed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrafficStats, getBacklinks, getCrawledUrls } from "../bing-webmaster";

const ENV = { BING_WEBMASTER_API_KEY: "test-key" } as never;

function mockBing(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("getTrafficStats (GetRankAndTrafficStats)", () => {
  it("maps rows to daily impressions/clicks", async () => {
    mockBing({
      d: [
        { Date: "2026-06-01", Impressions: 100, Clicks: 5 },
        { Date: "2026-06-02", Impressions: 50, Clicks: 2 },
      ],
    });
    const rows = await getTrafficStats(ENV, { skipCache: true });
    expect(rows).toEqual([
      { date: "2026-06-01", impressions: 100, clicks: 5 },
      { date: "2026-06-02", impressions: 50, clicks: 2 },
    ]);
  });

  it("drops unparseable-date rows and defaults missing counts to 0", async () => {
    mockBing({ d: [{ Date: "garbage" }, { Date: "2026-06-03" }] });
    const rows = await getTrafficStats(ENV, { skipCache: true });
    expect(rows).toEqual([{ date: "2026-06-03", impressions: 0, clicks: 0 }]);
  });
});

describe("getBacklinks (GetLinkCounts)", () => {
  it("maps rows to url + inboundLinks", async () => {
    mockBing({
      d: [
        { Url: "https://meetmeatthefair.com/a", Count: 12 },
        { Url: "https://meetmeatthefair.com/b", Count: 3 },
      ],
    });
    const rows = await getBacklinks(ENV, { skipCache: true });
    expect(rows).toEqual([
      { url: "https://meetmeatthefair.com/a", inboundLinks: 12 },
      { url: "https://meetmeatthefair.com/b", inboundLinks: 3 },
    ]);
  });
});

describe("getCrawledUrls (GetChildrenUrlInfo)", () => {
  it("maps rows, parsing dates and defaulting fields", async () => {
    mockBing({
      d: [
        {
          Url: "https://meetmeatthefair.com/a",
          IsPage: true,
          LastCrawledDate: "2026-06-01",
          DiscoveryDate: "2026-05-01",
          TotalChildUrlCount: 4,
        },
      ],
    });
    const rows = await getCrawledUrls(ENV, { skipCache: true });
    expect(rows).toEqual([
      {
        url: "https://meetmeatthefair.com/a",
        isPage: true,
        lastCrawled: "2026-06-01T00:00:00.000Z",
        discoveryDate: "2026-05-01T00:00:00.000Z",
        totalChildUrlCount: 4,
      },
    ]);
  });

  it("returns [] on an empty/garbage envelope instead of throwing", async () => {
    mockBing({ d: null });
    const rows = await getCrawledUrls(ENV, { skipCache: true });
    expect(rows).toEqual([]);
  });
});
