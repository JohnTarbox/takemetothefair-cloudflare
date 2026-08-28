/**
 * OPE-592 — one page counted as three.
 *
 * `get_query_pages` returned FIVE rows for THREE distinct paths, the Vermont
 * blog guide appearing three times (13 + 11 + 11 impressions), with
 * `totals.pages: 5`.
 *
 * The mechanism is not the secondary-dimension the ticket hypothesised — the
 * request asks for `dimensions: ["page"]` only. It is that GSC keys rows on the
 * full URL while `pathFromGscPageKey` returns `u.pathname`, dropping host,
 * query string and fragment. Apex vs www, `?utm_source=…` and `#fragment`
 * variants collapse to one displayed path and keep separate metric rows.
 *
 * ── Why the direction matters ───────────────────────────────────────────────
 * The tool exists to detect cannibalization — "multiple pages competing for the
 * same query". A caller counting competitors read 5 where the truth is 3, and
 * any single row understated that page's impressions. Both errors push toward
 * "more cannibalization than there is", which is the direction that ships an
 * unnecessary canonicalization or content intervention.
 */
import { describe, it, expect } from "vitest";
import { collapseQueryPageRows } from "../search-console";

const SITE = "https://meetmeatthefair.com";
const VT = "/blog/vermont-agricultural-fairs-2026-your-guide";

/** The exact shape observed, as three GSC URL keys for one page. */
const OBSERVED = [
  {
    keys: [`${SITE}/events/tunbridge-worlds-fair/2026`],
    clicks: 1,
    impressions: 3,
    ctr: 0.333,
    position: 1.0,
  },
  { keys: [`${SITE}${VT}`], clicks: 0, impressions: 13, ctr: 0, position: 5.692 },
  {
    keys: [`${SITE}${VT}?utm_source=newsletter`],
    clicks: 0,
    impressions: 11,
    ctr: 0,
    position: 5.636,
  },
  {
    keys: [`https://www.meetmeatthefair.com${VT}`],
    clicks: 0,
    impressions: 11,
    ctr: 0,
    position: 5.636,
  },
  { keys: [`${SITE}/events/vermont`], clicks: 0, impressions: 63, ctr: 0, position: 6.794 },
];

describe("OPE-592 — at most one row per distinct path", () => {
  const out = collapseQueryPageRows(SITE, OBSERVED);

  it("returns 3 rows for the 5 GSC keys — the headline defect", () => {
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.path)).size).toBe(3);
  });

  it("the VT guide appears exactly once", () => {
    expect(out.filter((r) => r.path === VT)).toHaveLength(1);
  });

  it("its impressions are SUMMED, not one of the three fragments", () => {
    // 13 + 11 + 11. Reading any single row understated the page by ~62%.
    expect(out.find((r) => r.path === VT)!.impressions).toBe(35);
  });

  it("collapses a query-string variant onto the bare path", () => {
    // `?utm_source=` is the same page. GSC keys them apart; a PATH view must not.
    const withUtm = collapseQueryPageRows(SITE, [
      { keys: [`${SITE}${VT}`], clicks: 0, impressions: 10, ctr: 0, position: 5 },
      { keys: [`${SITE}${VT}?utm_source=x`], clicks: 0, impressions: 5, ctr: 0, position: 7 },
    ]);
    expect(withUtm).toHaveLength(1);
    expect(withUtm[0].impressions).toBe(15);
  });

  it("collapses an apex/www pair", () => {
    const hosts = collapseQueryPageRows(SITE, [
      { keys: [`${SITE}${VT}`], clicks: 0, impressions: 10, ctr: 0, position: 5 },
      {
        keys: [`https://www.meetmeatthefair.com${VT}`],
        clicks: 0,
        impressions: 4,
        ctr: 0,
        position: 9,
      },
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].impressions).toBe(14);
  });

  it("does NOT merge genuinely different paths", () => {
    // The risk of any dedup: collapsing too far would hide real cannibalization,
    // which is the failure this tool exists to catch.
    expect(out.map((r) => r.path).sort()).toEqual(
      ["/events/tunbridge-worlds-fair/2026", "/events/vermont", VT].sort()
    );
  });
});

describe("OPE-592 — the arithmetic the acceptance specifies", () => {
  it("position is IMPRESSION-WEIGHTED, not a naive mean", () => {
    // A naive mean of 1.0 and 9.0 is 5.0. Weighted by 1 vs 99 impressions the
    // truth is ~8.92 — a page that ranks ~9 for essentially everyone who saw it.
    // Reporting 5.0 would read as "page one", which is the wrong intervention.
    const weighted = collapseQueryPageRows(SITE, [
      { keys: [`${SITE}${VT}`], clicks: 0, impressions: 1, ctr: 0, position: 1.0 },
      { keys: [`${SITE}${VT}?a=1`], clicks: 0, impressions: 99, ctr: 0, position: 9.0 },
    ]);
    expect(weighted[0].position).toBeCloseTo(8.92, 2);
    expect(weighted[0].position).not.toBeCloseTo(5.0, 1);
  });

  it("ctr is recomputed from the totals, not averaged", () => {
    // Averaging ratios weights a 1-impression row equally with a 99-impression
    // one. Real CTR here is 10/100.
    const ctr = collapseQueryPageRows(SITE, [
      { keys: [`${SITE}${VT}`], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
      { keys: [`${SITE}${VT}?a=1`], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ]);
    expect(ctr[0].ctr).toBeCloseTo(0.1, 5);
  });

  it("does not divide by zero on a page with no impressions", () => {
    const zero = collapseQueryPageRows(SITE, [
      { keys: [`${SITE}${VT}`], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ]);
    expect(zero[0].ctr).toBe(0);
    expect(zero[0].position).toBe(0);
    expect(Number.isNaN(zero[0].position)).toBe(false);
  });

  it("orders by impressions so the biggest competitor reads first", () => {
    expect(out2().map((r) => r.impressions)).toEqual([63, 35, 3]);
  });
});

function out2() {
  return collapseQueryPageRows(SITE, OBSERVED);
}
