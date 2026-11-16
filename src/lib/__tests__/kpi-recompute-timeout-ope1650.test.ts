/**
 * OPE-1650 — a GA4/GSC timeout must not take down the whole KPI recompute.
 *
 * `runReport` (ga4.ts) and the GSC client abort their own fetch after 10 s and
 * re-throw the bare AbortError; the KPI helpers swallowed only config/API
 * errors, so one slow Google answer rejected `readKpiValues`' Promise.all and
 * the route returned an empty 500 with NO kpi rows written (26 runs on 11-13).
 *
 * The Google clients and the click reader are mocked; D1 is a stub whose every
 * query resolves to no rows, which the D1-backed readers already turn into
 * `value: null`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ga4 = vi.hoisted(() => ({
  getMaxGa4DateWithUsers: vi.fn(),
  getOrganicSessions: vi.fn(),
}));
const gsc = vi.hoisted(() => ({
  getMaxGscDataDate: vi.fn(),
  getSiteSearchQueries: vi.fn(),
}));
vi.mock("@/lib/ga4", () => ga4);
vi.mock("@/lib/search-console", () => gsc);
vi.mock("@/lib/analytics/organic-conversion-clicks", () => ({
  readOrganicConversionClicks: vi.fn(async () => ({
    status: "ok",
    organicClicks: 12,
    allClicks: 40,
    firstAttributedAt: new Date("2026-09-01T00:00:00Z"),
  })),
}));

import { isAbortError, readKpiValues } from "../kpi-states";

/** Any drizzle chain → awaitable empty result. */
function emptyDb(): never {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve([]);
      return () => new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler) as never;
}

function abortError(): Error {
  // What `fetch` throws when `controller.abort()` fires (the runReport timer).
  return new DOMException("The operation was aborted", "AbortError");
}

beforeEach(() => {
  vi.clearAllMocks();
  gsc.getMaxGscDataDate.mockResolvedValue("2026-11-13");
  gsc.getSiteSearchQueries.mockResolvedValue({ queries: [] });
  ga4.getMaxGa4DateWithUsers.mockResolvedValue("2026-11-14");
  ga4.getOrganicSessions.mockResolvedValue(300);
});

describe("isAbortError", () => {
  it("matches what fetch throws on abort and on AbortSignal.timeout", () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isAbortError(new TypeError("x"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("readKpiValues under a Google timeout", () => {
  it("positive landmark: with Google answering, conversion_rate is computed", async () => {
    const v = await readKpiValues(emptyDb(), {} as never);
    expect(v.conversion_rate.value).toBeCloseTo(12 / 300);
  });

  it("GA4 organic sessions timing out → conversion_rate is null with reason ga4_timeout, and the other KPIs still come back", async () => {
    ga4.getOrganicSessions.mockRejectedValue(abortError());
    const v = await readKpiValues(emptyDb(), {} as never);
    expect(v.conversion_rate.value).toBeNull();
    expect(v.conversion_rate.meta).toMatchObject({ reason: "ga4_timeout" });
    expect(Object.keys(v).sort()).toEqual(
      ["brand_share", "conversion_rate", "site_ctr", "sitemap_quality", "time_to_index_h"].sort()
    );
  });

  it("the GA4 and GSC freshness probes timing out → null freshness, not a rejection", async () => {
    ga4.getMaxGa4DateWithUsers.mockRejectedValue(abortError());
    gsc.getMaxGscDataDate.mockRejectedValue(abortError());
    const v = await readKpiValues(emptyDb(), {} as never);
    expect(v.conversion_rate.meta).toMatchObject({ ga4MaxDate: null });
    expect(v.brand_share.meta).toMatchObject({ gscMaxDate: null });
  });

  it("a NON-timeout error still throws — a real bug is not hidden behind a null tile", async () => {
    ga4.getOrganicSessions.mockRejectedValue(new TypeError("cannot read properties of undefined"));
    await expect(readKpiValues(emptyDb(), {} as never)).rejects.toThrow(TypeError);
    ga4.getOrganicSessions.mockResolvedValue(300);
    ga4.getMaxGa4DateWithUsers.mockRejectedValue(new RangeError("boom"));
    await expect(readKpiValues(emptyDb(), {} as never)).rejects.toThrow(RangeError);
  });
});
