/**
 * OPE-592 (09-23 bounce) — the two GSC oracles must agree on one page's total.
 *
 * Live: get_query_pages("vermont county fairs 2026") → VT guide 35 impressions
 * (summed across URL variants); get_search_queries(path=…) → 13 for the same
 * query and window, because it filtered GSC on ONE exact URL. Same raw rows,
 * two answers. Both now collapse variants by pathname.
 */
import { describe, it, expect } from "vitest";
import { collapseQueryPageRows, collapseQueryRowsForPath } from "../search-console";

const SITE = "sc-domain:meetmeatthefair.com";
const PATH =
  "/blog/vermont-agricultural-fairs-2026-your-guide-to-the-best-fairs-in-the-green-mountain-state";
const Q = "vermont county fairs 2026";

/** The three variant rows GSC returned for the specimen (13 + 11 + 11). */
const VARIANTS = [
  { url: `https://meetmeatthefair.com${PATH}`, impressions: 13, clicks: 1, position: 5.692 },
  { url: `https://www.meetmeatthefair.com${PATH}`, impressions: 11, clicks: 0, position: 5.5 },
  {
    url: `https://meetmeatthefair.com${PATH}?utm_source=fb`,
    impressions: 11,
    clicks: 0,
    position: 5.8,
  },
];

describe("the two oracles reconcile", () => {
  it("ACCEPTANCE: per-page query total == per-query page total (35, not 13)", () => {
    const byPage = collapseQueryPageRows(
      SITE,
      VARIANTS.map((v) => ({ keys: [v.url], ...v }))
    ).find((r) => r.path === PATH)!;
    const byQuery = collapseQueryRowsForPath(
      SITE,
      PATH,
      VARIANTS.map((v) => ({ keys: [Q, v.url], ...v }))
    ).find((r) => r.query === Q)!;
    expect(byQuery.impressions).toBe(35);
    expect(byQuery.impressions).toBe(byPage.impressions);
    expect(byQuery.position).toBeCloseTo(byPage.position, 10);
  });

  it("the `contains` over-match is filtered: /x-2 is not /x", () => {
    const rows = [
      { keys: [Q, `https://meetmeatthefair.com${PATH}`], impressions: 13, clicks: 0, position: 5 },
      {
        keys: [Q, `https://meetmeatthefair.com${PATH}-2`],
        impressions: 99,
        clicks: 0,
        position: 2,
      },
    ];
    expect(collapseQueryRowsForPath(SITE, PATH, rows)[0].impressions).toBe(13);
  });

  it("position is impression-weighted, CTR recomputed from sums", () => {
    const rows = [
      { keys: ["q", `https://meetmeatthefair.com${PATH}`], impressions: 3, clicks: 3, position: 1 },
      {
        keys: ["q", `https://www.meetmeatthefair.com${PATH}`],
        impressions: 63,
        clicks: 0,
        position: 6.8,
      },
    ];
    const [r] = collapseQueryRowsForPath(SITE, PATH, rows);
    expect(r.position).toBeCloseTo((1 * 3 + 6.8 * 63) / 66, 10);
    expect(r.ctr).toBeCloseTo(3 / 66, 10);
  });
});

describe("getSearchQueriesForPage uses the collapse", () => {
  it("asks for query×page rows by path and collapses them", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/lib/search-console.ts`, "utf8");
    const fn = src.slice(src.indexOf("export async function getSearchQueriesForPage"));
    expect(fn).toMatch(/dimensions: \["query", "page"\]/);
    expect(fn).toMatch(/operator: "contains",\s*expression: path,/);
    expect(fn).toMatch(/collapseQueryRowsForPath\(siteUrl, path, data\.rows \?\? \[\]\)/);
  });
});
