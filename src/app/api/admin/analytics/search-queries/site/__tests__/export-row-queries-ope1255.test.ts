/**
 * OPE-1255 — the site-wide query list excludes someone else's GSC export rows
 * by default (and says how many it removed), keeps them on request, and never
 * touches the reader's raw result.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({ isAuthorized: vi.fn(async () => true) }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: vi.fn(() => ({})) }));
vi.mock("@/lib/search-console", async (orig) => ({
  ...(await orig<typeof import("@/lib/search-console")>()),
  getSiteSearchQueries: vi.fn(async () => ({
    dateRange: { startDate: "2026-09-01", endDate: "2026-09-30" },
    queries: [
      { query: "fryeburg fair 2026", clicks: 40, impressions: 900, ctr: 0.044, position: 3 },
      { query: "fairs in bangor, me", clicks: 2, impressions: 60, ctr: 0.033, position: 8 },
      {
        query: "craft fairs on cape cod this weekend,410,3051,13.44%,3.16",
        clicks: 0,
        impressions: 12,
        ctr: 0,
        position: 9,
      },
    ],
    totals: { clicks: 42, impressions: 972, queries: 3 },
  })),
}));

import { GET } from "../route";

type Body = {
  queries: Array<{ query: string }>;
  totals: Record<string, number>;
  excludedExportRowQueries?: { count: number; impressions: number };
};

const req = (qs = "") =>
  new NextRequest(`https://meetmeatthefair.com/api/admin/analytics/search-queries/site${qs}`);

describe("GET /api/admin/analytics/search-queries/site — OPE-1255", () => {
  it("excludes export-row queries by default and reports the removal", async () => {
    const body = (await (await GET(req())).json()) as Body;
    expect(body.queries.map((q) => q.query)).toEqual([
      "fryeburg fair 2026",
      "fairs in bangor, me", // a comma alone is a real query
    ]);
    expect(body.totals).toMatchObject({ clicks: 42, impressions: 960, queries: 2 });
    expect(body.excludedExportRowQueries).toEqual({ count: 1, impressions: 12 });
  });

  it("keeps them when include_export_rows=1", async () => {
    const body = (await (await GET(req("?include_export_rows=1"))).json()) as Body;
    expect(body.queries).toHaveLength(3);
    expect(body.excludedExportRowQueries).toBeUndefined();
  });
});
