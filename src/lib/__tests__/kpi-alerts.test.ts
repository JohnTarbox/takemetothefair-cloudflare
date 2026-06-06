/**
 * A3 KPI alerts (analyst Item 8, 2026-05-30) — unit tests for the
 * dispatcher's routing, debounce, value formatting, and payload shape.
 *
 * D1 is mocked through the standard drizzle-chain shape; fetch is stubbed
 * for Slack webhook delivery. The integration with `recomputeKpiStates`
 * is exercised indirectly via the dispatch call shape — the recompute
 * itself has its own test suite (`kpi-states.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Cloudflare bindings so getCloudflareEnv() returns our shimmed env.
const MOCK_ENV: Record<string, string | undefined> = {};
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => MOCK_ENV,
}));

// Mock sendEmail so we can assert email-routing without touching Resend.
// vi.hoisted lets us declare the spy at the top of the (hoisted) module-
// init order; standard `const` declarations get evicted by vi.mock's
// hoisting and produce a TDZ error.
const { sendEmailSpy } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(async () => ({ ok: true, provider: "stub" as const })),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: sendEmailSpy,
}));

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(async () => undefined),
}));

import { dispatchKpiAlert, __test } from "../kpi-alerts";

const { formatValue, buildSlackPayload, CATEGORY_BY_KPI, YELLOW_DEBOUNCE_HOURS } = __test;

interface MockDbState {
  yellowCountByKpi: Record<string, number>;
  /** Rows returned by the stale-flap previous-row lookup. The dispatcher
   *  reads `[current, previous]` from this list (index 1 = previous). */
  staleFlapHistory?: Array<{ value: number | null }>;
}

function makeMockDb(state: MockDbState) {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          // The YELLOW-debounce path awaits `where()` directly to get a count.
          // The stale-flap path chains `.orderBy().limit()` to read history.
          // Return a thenable that supports both — Promise.resolve for the
          // debounce, and an orderBy/limit chain for the stale-flap probe.
          const debounceRows = [{ c: state.yellowCountByKpi["__current"] ?? 0 }];
          const historyRows = state.staleFlapHistory ?? [];
          const thenable = Promise.resolve(debounceRows) as Promise<unknown> & {
            orderBy: () => { limit: () => Promise<unknown> };
          };
          thenable.orderBy = () => ({
            limit: () => Promise.resolve(historyRows),
          });
          return thenable;
        },
      }),
    }),
    // Stale-flap suppression writes an admin_actions audit row via
    // `db.insert(...).values(...).catch(...)`. Mock the insert as a no-op.
    insert: () => ({
      values: () => Promise.resolve(),
    }),
  } as unknown as Parameters<typeof dispatchKpiAlert>[0];
}

beforeEach(() => {
  for (const k of Object.keys(MOCK_ENV)) delete MOCK_ENV[k];
  sendEmailSpy.mockClear();
  vi.unstubAllGlobals();
});

describe("KPI alert routing", () => {
  it("revenue/marketing KPIs route to business category", () => {
    expect(CATEGORY_BY_KPI.site_ctr).toBe("business");
    expect(CATEGORY_BY_KPI.conversion_rate).toBe("business");
    expect(CATEGORY_BY_KPI.brand_share).toBe("business");
  });

  it("technical KPIs route to technical category", () => {
    expect(CATEGORY_BY_KPI.sitemap_quality).toBe("technical");
    expect(CATEGORY_BY_KPI.time_to_index_h).toBe("technical");
  });
});

describe("formatValue", () => {
  it("renders CTR/conversion as 2dp percent", () => {
    expect(formatValue("site_ctr", 0.0185)).toBe("1.85%");
    expect(formatValue("conversion_rate", 0.05)).toBe("5.00%");
  });
  it("renders brand_share as 1dp percent", () => {
    expect(formatValue("brand_share", 0.124)).toBe("12.4%");
  });
  it("renders sitemap_quality as 1dp number", () => {
    expect(formatValue("sitemap_quality", 67.3)).toBe("67.3");
  });
  it("renders time_to_index_h as 1dp hours", () => {
    expect(formatValue("time_to_index_h", 42.51)).toBe("42.5h");
  });
  it("renders null as 'unknown'", () => {
    expect(formatValue("site_ctr", null)).toBe("unknown");
  });
});

describe("dispatchKpiAlert — no-op cases", () => {
  it("does not dispatch on GREEN transitions (resolutions handled separately)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/x";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "YELLOW",
      toState: "GREEN",
      value: 0.025,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("non-actionable-state");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("does not dispatch when no config is set for the routed category", async () => {
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "RED",
      value: 0.005,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("no-config");
  });
});

describe("dispatchKpiAlert — RED transitions", () => {
  it("always fires for RED regardless of debounce", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/x";
    // Even with a recent prior YELLOW in the window, RED must send.
    const db = makeMockDb({ yellowCountByKpi: { __current: 5 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "YELLOW",
      toState: "RED",
      value: 0.005,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
    expect(result.channel).toBe("slack");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("routes business KPI to BUSINESS Slack channel", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/business";
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "RED",
      value: 0.008,
      detectedAt: new Date(),
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hooks.slack.com/business");
  });

  it("routes technical KPI to TECHNICAL Slack channel", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/business";
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchKpiAlert(db, {
      kpiName: "sitemap_quality",
      fromState: "GREEN",
      toState: "RED",
      value: 30,
      detectedAt: new Date(),
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hooks.slack.com/tech");
  });

  it("delivers to both Slack and email when both configured", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/x";
    MOCK_ENV.ALERT_EMAIL_BUSINESS = "ops@example.com";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "RED",
      value: 0.005,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
    expect(result.channel).toBe("both");
    expect(sendEmailSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "ops@example.com", source: "kpi-alert:site_ctr" })
    );
  });
});

describe("dispatchKpiAlert — YELLOW debounce", () => {
  it("sends YELLOW alert when no prior YELLOW within 72h (count=1, just-inserted)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/x";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "YELLOW",
      value: 0.015,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
  });

  it("debounces YELLOW alert when a prior YELLOW exists in window (count>=2)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/x";
    const db = makeMockDb({ yellowCountByKpi: { __current: 2 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "YELLOW",
      value: 0.015,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("yellow-debounced");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dispatchKpiAlert — STALE", () => {
  it("STALE on a BUSINESS KPI still routes to TECHNICAL channel (broken feed is a pipeline issue)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/business";
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({ yellowCountByKpi: { __current: 1 } });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "GREEN",
      toState: "STALE",
      value: null,
      detectedAt: new Date(),
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hooks.slack.com/tech");
  });
});

describe("buildSlackPayload", () => {
  it("includes the KPI display name, transition, value, and analytics link", () => {
    const p = buildSlackPayload({
      kpiName: "site_ctr",
      displayName: "Site CTR",
      fromState: "GREEN",
      toState: "RED",
      value: 0.008,
      category: "business",
      detectedAt: new Date("2026-05-30T12:00:00Z"),
    });
    expect(p.text).toContain("Site CTR");
    expect(p.text).toContain("GREEN → RED");
    expect(p.text).toContain("0.80%");
    const blocks = p.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
    const context = blocks.find((b) => b.type === "context");
    expect(context?.elements?.[0]?.text).toContain("meetmeatthefair.com/admin/analytics");
  });
});

describe("YELLOW_DEBOUNCE_HOURS", () => {
  it("is 72h per spec", () => {
    expect(YELLOW_DEBOUNCE_HOURS).toBe(72);
  });
});

describe("dispatchKpiAlert — E (ALERT1) STALE-flap suppression", () => {
  // historyRows[0] is the just-inserted current row; historyRows[1] is the
  // previous row whose `value` is compared to the dispatcher's `value` arg.
  it("suppresses STALE→RED when value is unchanged across the flip", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      staleFlapHistory: [{ value: 0.5478 }, { value: 0.5478 }],
    });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "sitemap_quality",
      fromState: "STALE",
      toState: "RED",
      value: 0.5478,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("stale-flap-suppressed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it("suppresses RED→STALE when value is unchanged", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      staleFlapHistory: [{ value: 0.5478 }, { value: 0.5478 }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    );

    const result = await dispatchKpiAlert(db, {
      kpiName: "sitemap_quality",
      fromState: "RED",
      toState: "STALE",
      value: 0.5478,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("stale-flap-suppressed");
  });

  it("suppresses GREEN→STALE when both values are null (feed went away mid-flap)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      staleFlapHistory: [{ value: null }, { value: null }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    );

    const result = await dispatchKpiAlert(db, {
      kpiName: "brand_share",
      fromState: "GREEN",
      toState: "STALE",
      value: null,
      detectedAt: new Date(),
    });
    expect(result.reason).toBe("stale-flap-suppressed");
  });

  it("FIRES on STALE→RED when value DID move (genuine value wobble, not just freshness)", async () => {
    // Matches the live 2026-06-06 10:10 sitemap_quality case the email lists
    // as a noise alert — 0.5478 → 0.5481 is a real numerical wobble, so
    // option-(a) semantics correctly do NOT suppress it. Operator can widen
    // the predicate later if even tiny wobbles should be silenced.
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      staleFlapHistory: [{ value: 0.5481 }, { value: 0.5478 }],
    });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "sitemap_quality",
      fromState: "STALE",
      toState: "RED",
      value: 0.5481,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does NOT suppress a RED→YELLOW transition (no STALE involvement)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_BUSINESS = "https://hooks.slack.com/business";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      // History rows present but irrelevant — predicate's early-return
      // on `involvesStale=false` short-circuits before the DB read.
      staleFlapHistory: [{ value: 0.005 }, { value: 0.005 }],
    });
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatchKpiAlert(db, {
      kpiName: "site_ctr",
      fromState: "RED",
      toState: "YELLOW",
      value: 0.005,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
  });

  it("does NOT suppress when no previous history row exists (first-ever STALE)", async () => {
    MOCK_ENV.SLACK_WEBHOOK_URL_TECHNICAL = "https://hooks.slack.com/tech";
    const db = makeMockDb({
      yellowCountByKpi: { __current: 1 },
      staleFlapHistory: [{ value: 0.5 }], // only the current row, no previous
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    );

    const result = await dispatchKpiAlert(db, {
      kpiName: "sitemap_quality",
      fromState: null,
      toState: "STALE",
      value: 0.5,
      detectedAt: new Date(),
    });
    expect(result.dispatched).toBe(true);
  });
});
