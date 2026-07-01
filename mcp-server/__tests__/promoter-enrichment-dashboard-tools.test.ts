/**
 * OPE-38 — MCP tool wiring for the promoter-enrichment flywheel dashboard.
 *
 * The two analytics tools (get_promoter_enrichment_coverage and
 * get_promoter_enrichment_rule_agreement) are thin HTTP proxies to
 * /api/admin/analytics/promoter-enrichment-coverage. These tests register them
 * via registerAnalyticsTools and assert they call the right endpoint with the
 * X-Internal-Key header and surface the flywheel fields. Global fetch is
 * mocked — no real network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { CapturingMcpServer } from "./setup-db.js";
import { registerAnalyticsTools } from "../src/tools/analytics.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

const DASHBOARD_PAYLOAD = {
  success: true,
  generatedAt: "2026-07-01T00:00:00.000Z",
  total: 50,
  queueDepth: 7,
  autoApply: { autoMerged: 12, approved: 4, decided: 16, autoApplyPct: 75 },
  blocked: { blockedTotal: 4, blockedRatePct: 8, byReason: { js_gated: 3, parked: 1 } },
  candidatesTrend: [{ weekStart: "2026-06-22", count: 5 }],
  ruleAgreement: [
    {
      proposedField: "logo",
      extractionMethod: "og-image",
      agreements: 20,
      disagreements: 0,
      sampleSize: 20,
      agreementPct: 100,
      promotable: true,
    },
  ],
};

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function mockAnalyticsFetch(payload: unknown): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function register() {
  const server = new CapturingMcpServer();
  registerAnalyticsTools(server as never, ADMIN_AUTH, ENV as never);
  return server;
}

describe("get_promoter_enrichment_coverage (OPE-38 extended)", () => {
  it("proxies to the coverage endpoint with the internal key and returns flywheel fields", async () => {
    const m = mockAnalyticsFetch(DASHBOARD_PAYLOAD);
    restore = m.restore;
    const server = register();

    const result = (await server.invoke("get_promoter_enrichment_coverage")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe(
      "https://meetmeatthefair.com/api/admin/analytics/promoter-enrichment-coverage"
    );
    expect(m.calls[0].headers["X-Internal-Key"]).toBe("test-key");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.autoApply.autoApplyPct).toBe(75);
    expect(parsed.blocked.byReason.js_gated).toBe(3);
    expect(parsed.ruleAgreement[0].promotable).toBe(true);
  });
});

describe("get_promoter_enrichment_rule_agreement (OPE-38)", () => {
  it("is registered and returns only the rule-agreement slice + autoApply", async () => {
    const m = mockAnalyticsFetch(DASHBOARD_PAYLOAD);
    restore = m.restore;
    const server = register();

    expect(server.handlers.has("get_promoter_enrichment_rule_agreement")).toBe(true);

    const result = (await server.invoke("get_promoter_enrichment_rule_agreement")) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed.autoApply.autoApplyPct).toBe(75);
    expect(parsed.ruleAgreement).toHaveLength(1);
    expect(parsed.ruleAgreement[0].proposedField).toBe("logo");
    // The heavy coverage fields are intentionally not echoed by this tool.
    expect(parsed.total).toBeUndefined();
  });

  it("surfaces an empty ruleAgreement array when the endpoint omits it", async () => {
    const m = mockAnalyticsFetch({ success: true, generatedAt: "2026-07-01T00:00:00.000Z" });
    restore = m.restore;
    const server = register();
    const result = (await server.invoke("get_promoter_enrichment_rule_agreement")) as {
      content: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ruleAgreement).toEqual([]);
  });
});
