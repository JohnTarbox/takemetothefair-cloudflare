/**
 * OPE-1131 part 2 — the rest of the inventory: samples labelled as samples,
 * feeds that stopped, and "—" that never said why. Each driven to the failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeFacebookTraffic, TRAFFIC_SOURCE_LIMIT } from "@/lib/ga4";
import { capActivityPerSide } from "../activity";
import type { ActivityEntry } from "../types";

const eng = vi.hoisted(() => ({ getActiveItems: vi.fn(), getScanState: vi.fn() }));
vi.mock("@/lib/recommendations/engine", async (orig) => ({
  ...(await orig<typeof import("@/lib/recommendations/engine")>()),
  getActiveItems: eng.getActiveItems,
  getScanState: eng.getScanState,
}));
import { loadRecommendationsSummary } from "../content";
import { loadConversions } from "../conversions";

const HOUR = 3_600_000;

beforeEach(() => {
  eng.getActiveItems.mockReset();
  eng.getScanState.mockReset();
});

describe("Facebook traffic summed from a capped source report", () => {
  const row = (source: string, sessions: number) => ({
    source,
    medium: "referral",
    sessions,
    activeUsers: sessions,
  });

  it("a FULL report is flagged — a Facebook source below the cut was never read", () => {
    const full = Array.from({ length: TRAFFIC_SOURCE_LIMIT }, (_, i) =>
      row(i === 0 ? "m.facebook.com" : `site${i}.com`, 10)
    );
    expect(summarizeFacebookTraffic(full, TRAFFIC_SOURCE_LIMIT).sourcesCapped).toBe(true);
  });

  it("a short report is the whole population — no flag", () => {
    const short = [row("m.facebook.com", 5), row("google", 50)];
    expect(summarizeFacebookTraffic(short, TRAFFIC_SOURCE_LIMIT).sourcesCapped).toBeUndefined();
  });
});

describe("activity feeds are capped PER SIDE", () => {
  it("a burst of admin rows no longer crowds every conversion out", () => {
    const admin: ActivityEntry[] = Array.from({ length: 15 }, (_, i) => ({
      ts: 1000 + i,
      kind: "admin",
      description: `a${i}`,
    }));
    const conv: ActivityEntry[] = [
      { ts: 1, kind: "conversion", description: "c1" },
      { ts: 2, kind: "conversion", description: "c2" },
    ];
    const out = capActivityPerSide([...admin, ...conv], 10);
    expect(out.filter((e) => e.kind === "conversion")).toHaveLength(2);
    expect(out.filter((e) => e.kind === "admin")).toHaveLength(10);
    // newest first overall
    expect(out[0].ts).toBe(1014);
  });
});

describe("Recommendations tile — 'All clear' is not what a stopped scanner looks like", () => {
  it("is stale when the last successful scan is older than the threshold", async () => {
    eng.getActiveItems.mockResolvedValue([]);
    eng.getScanState.mockResolvedValue({
      lastSuccessfulScanAt: new Date(Date.now() - 10 * 24 * HOUR),
    });
    const c = await loadRecommendationsSummary({} as never);
    expect(c.totalItems).toBe(0);
    expect(c.actionableMeasured.state).toBe("stale");
  });

  it("is ok after a recent scan", async () => {
    eng.getActiveItems.mockResolvedValue([]);
    eng.getScanState.mockResolvedValue({ lastSuccessfulScanAt: new Date(Date.now() - HOUR) });
    const c = await loadRecommendationsSummary({} as never);
    expect(c.actionableMeasured.state).toBe("ok");
  });
});

describe("Conversions — judged on the beacon, not on conversions", () => {
  /** Two counted queries (.where) then the MAX query (awaited after .from). */
  function db(current: number, previous: number, lastSec: number | null) {
    const counts = [[{ c: current }], [{ c: previous }]];
    let i = 0;
    const fromResult = {
      where: () => Promise.resolve(counts[i++]),
      then: (res: (v: unknown) => unknown) => res([{ last: lastSec }]),
    };
    return { select: () => ({ from: () => fromResult }) } as never;
  }
  const d = new Date();

  it("a beacon silent for a day makes the count stale", async () => {
    const lastSec = Math.floor((Date.now() - 24 * HOUR) / 1000);
    const c = await loadConversions(db(0, 3, lastSec), d, d, d, 7);
    expect(c.currentMeasured.state).toBe("stale");
  });

  it("a live beacon with zero conversions is a real zero", async () => {
    const lastSec = Math.floor((Date.now() - 5 * 60_000) / 1000);
    const c = await loadConversions(db(0, 3, lastSec), d, d, d, 7);
    expect(c.currentMeasured).toMatchObject({ state: "ok", value: 0 });
  });
});

describe("page wiring", () => {
  const page = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");

  it("KPI badges are judged on their own age — and the stale branch is live", () => {
    expect(page).toMatch(/freshness\(row\.state, "kpi_state_history", row\.computedAt/);
    // Anchored on the branch itself: a disabled `if (false && …)` must fail.
    expect(page).toMatch(/\n\s*if \(badge\.state === "stale"\) \{\s*return \{\s*state: "STALE"/);
  });

  it("loadActivity actually uses the per-side cap", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/analytics-overview/activity.ts"), "utf8");
    expect(src).toMatch(/\n\s*return capActivityPerSide\(merged, 10\);/);
  });

  it("the Facebook, Conversions and Recommendations tiles render measurements", () => {
    expect(page).toMatch(/summary\.sourcesCapped/);
    expect(page).toMatch(/measurementText\(card\.currentMeasured, fmt\)/);
    expect(page).toMatch(/measurementText\(c\.actionableMeasured, fmt\)/);
  });

  it("guard coverage no longer prints a bare 'n/a'", () => {
    expect(page).not.toMatch(/\? "n\/a"/);
    expect(page).toMatch(/pct\(c\.guardCoveragePct, "not instrumented yet"\)/);
  });
});
