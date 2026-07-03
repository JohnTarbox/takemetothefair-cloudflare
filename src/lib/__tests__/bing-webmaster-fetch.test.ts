/**
 * K50 — the new Bing client wrappers (getTrafficStats / getBacklinks /
 * getCrawledUrls). Stubs global fetch with a Bing JSON envelope and asserts the
 * defensive row-mapping (field extraction, date parsing, count defaulting, and
 * graceful empty handling). Env has no RATE_LIMIT_KV so the cache is bypassed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTrafficStats,
  getBacklinks,
  getCrawledUrls,
  getPageStats,
  getSitemaps,
} from "../bing-webmaster";

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

  it("uses POST with the {siteUrl,url,page} body (GetChildrenUrlInfo is POST-only)", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ d: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await getCrawledUrls(ENV, { skipCache: true, dir: "https://meetmeatthefair.com/" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("GetChildrenUrlInfo");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      url: "https://meetmeatthefair.com/",
      page: 0,
    });
  });

  it("returns [] when Bing NPEs with ErrorCode 2 (no crawl-children data) instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ErrorCode: 2,
              Message: "ERROR!!! Object reference not set to an instance of an object.",
            }),
            { status: 400 }
          )
      )
    );
    const rows = await getCrawledUrls(ENV, { skipCache: true });
    expect(rows).toEqual([]);
  });
});

describe("getPageStats (GetPageStats)", () => {
  // OPE-71 FIX 1: GetPageStats rows arrive double-wrapped as { d: { Page, ... } }
  // (same serialization as GetQueryStats). The `?? ` fallback must unwrap that
  // shape AND a flat shape — before the fix `r.Page` was undefined → "".
  it("extracts page from the double-wrapped { d: { Page, ... } } shape", async () => {
    mockBing({
      d: [
        {
          d: {
            Page: "https://meetmeatthefair.com/x",
            Clicks: 5,
            Impressions: 40,
            AvgClickPosition: -1,
            AvgImpressionPosition: 3.2,
          },
        },
      ],
    });
    const rows = await getPageStats(ENV, { skipCache: true });
    expect(rows).toEqual([
      {
        page: "https://meetmeatthefair.com/x",
        clicks: 5,
        impressions: 40,
        // AvgClickPosition: -1 sentinel normalizes to null.
        avgClickPosition: null,
        avgImpressionPosition: 3.2,
      },
    ]);
  });

  it("extracts page from the flat { Page, ... } shape (the ?? fallback)", async () => {
    mockBing({
      d: [
        {
          Page: "https://meetmeatthefair.com/y",
          Clicks: 2,
          Impressions: 10,
          AvgClickPosition: 4.5,
          AvgImpressionPosition: 6.1,
        },
      ],
    });
    const rows = await getPageStats(ENV, { skipCache: true });
    expect(rows).toEqual([
      {
        page: "https://meetmeatthefair.com/y",
        clicks: 2,
        impressions: 10,
        avgClickPosition: 4.5,
        avgImpressionPosition: 6.1,
      },
    ]);
  });
});

describe("getSitemaps (GetFeeds)", () => {
  // OPE-71 FIX 3: the exact Bing GetFeeds date field names couldn't be
  // live-verified (key is a secret), so firstDate() tries a candidate list per
  // field. A populated field maps through; a missing one → null.
  it("maps a populated candidate date field through and leaves missing ones null", async () => {
    mockBing({
      d: [
        {
          Url: "https://meetmeatthefair.com/sitemap.xml",
          SubmittedDate: "2026-06-01",
          // LastCrawledDate absent — none of the candidates present → null.
          UrlCount: 42,
          Status: "Success",
        },
      ],
    });
    const rows = await getSitemaps(ENV, { skipCache: true });
    expect(rows).toEqual([
      {
        url: "https://meetmeatthefair.com/sitemap.xml",
        submitted: "2026-06-01T00:00:00.000Z",
        lastCrawled: null,
        urlCount: 42,
        status: "Success",
      },
    ]);
  });

  it("reads an alternate candidate spelling (SubmittedDateTime / LastCrawled)", async () => {
    mockBing({
      d: [
        {
          Url: "https://meetmeatthefair.com/sitemap.xml",
          SubmittedDateTime: "2026-06-02",
          LastCrawled: "2026-06-03",
        },
      ],
    });
    const rows = await getSitemaps(ENV, { skipCache: true });
    expect(rows).toEqual([
      {
        url: "https://meetmeatthefair.com/sitemap.xml",
        submitted: "2026-06-02T00:00:00.000Z",
        lastCrawled: "2026-06-03T00:00:00.000Z",
        urlCount: 0,
        status: "Unknown",
      },
    ]);
  });
});
