/**
 * State-transition tests for the §6.3 KPI state machine. Tests the pure
 * `decideStateRow` helper extracted from `recomputeKpiStates` — no D1 mocking
 * needed; the IO portion is exercised through the integration smoke (cron
 * fires + admin/analytics page renders new states).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideStateRow } from "../kpi-states";

const NOW = new Date("2026-05-05T12:00:00Z");
const EARLIER = new Date("2026-05-01T12:00:00Z");
const FRESH = 60; // 1 min — never STALE
// Past site_ctr's 120h SLA (Phase 2.1 tuning); used to force STALE in tests
// where we want to assert STALE-state transition logic, not threshold values.
const STALE_6D = 6 * 86400;

describe("decideStateRow", () => {
  it("first run (no previous) marks state_changed and sets firstDetected to now", () => {
    const r = decideStateRow("site_ctr", 0.005, FRESH, undefined, NOW);
    expect(r.state).toBe("RED");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(false);
  });

  it("sustained RED carries forward firstDetectedAt", () => {
    const r = decideStateRow(
      "site_ctr",
      0.005,
      FRESH,
      { state: "RED", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("RED");
    expect(r.stateChangedFromPrevious).toBe(false);
    expect(r.firstDetectedAt).toEqual(EARLIER);
    expect(r.isResolution).toBe(false);
  });

  it("RED → YELLOW resets firstDetectedAt; not a resolution", () => {
    const r = decideStateRow(
      "site_ctr",
      0.015,
      FRESH,
      { state: "RED", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("YELLOW");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(false);
  });

  it("RED → GREEN counts as a resolution", () => {
    const r = decideStateRow(
      "site_ctr",
      0.025,
      FRESH,
      { state: "RED", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("GREEN");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(true);
  });

  it("YELLOW → GREEN counts as a resolution", () => {
    const r = decideStateRow(
      "conversion_rate",
      0.09,
      FRESH,
      { state: "YELLOW", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.isResolution).toBe(true);
  });

  it("GREEN → RED is a transition but not a resolution", () => {
    const r = decideStateRow(
      "site_ctr",
      0.005,
      FRESH,
      { state: "GREEN", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("RED");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(false);
  });

  it("INDETERMINATE → GREEN is a transition but not a resolution (no prior breach)", () => {
    // First time time-to-index gets a real reading after the data-collection
    // ramp. Should not write a kpi.state_resolved row — there was nothing to
    // resolve.
    const r = decideStateRow(
      "time_to_index_h",
      12,
      FRESH,
      { state: "INDETERMINATE", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("GREEN");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.isResolution).toBe(false);
  });

  it("RED → INDETERMINATE (data stops flowing) is a transition but not a resolution", () => {
    const r = decideStateRow(
      "time_to_index_h",
      null,
      FRESH,
      { state: "RED", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("INDETERMINATE");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.isResolution).toBe(false);
  });

  describe("STALE state", () => {
    it("GREEN → STALE is a transition (data feed degraded under healthy value)", () => {
      const r = decideStateRow(
        "site_ctr",
        0.05, // would be GREEN if data were fresh
        STALE_6D,
        { state: "GREEN", firstDetectedAt: EARLIER },
        NOW
      );
      expect(r.state).toBe("STALE");
      expect(r.stateChangedFromPrevious).toBe(true);
      expect(r.firstDetectedAt).toEqual(NOW);
      expect(r.isResolution).toBe(false);
    });

    it("STALE → STALE is sustained — firstDetectedAt carries forward", () => {
      const r = decideStateRow(
        "site_ctr",
        0.05,
        STALE_6D,
        { state: "STALE", firstDetectedAt: EARLIER },
        NOW
      );
      expect(r.state).toBe("STALE");
      expect(r.stateChangedFromPrevious).toBe(false);
      expect(r.firstDetectedAt).toEqual(EARLIER);
    });

    it("STALE → GREEN counts as a resolution (data feed recovered)", () => {
      // The 2026-04-27 → 2026-05-05 GA4 outage scenario: feed comes back,
      // value is healthy, and we want this transition logged so the trend
      // shows up in admin_actions even after the action-queue row drops.
      const r = decideStateRow(
        "site_ctr",
        0.05,
        FRESH,
        { state: "STALE", firstDetectedAt: EARLIER },
        NOW
      );
      expect(r.state).toBe("GREEN");
      expect(r.stateChangedFromPrevious).toBe(true);
      expect(r.firstDetectedAt).toEqual(NOW);
      expect(r.isResolution).toBe(true);
    });

    it("STALE wins over RED — broken feed invalidates value-based classification", () => {
      const r = decideStateRow(
        "site_ctr",
        0.001, // would be RED if data were fresh
        STALE_6D,
        undefined,
        NOW
      );
      expect(r.state).toBe("STALE");
    });
  });
});

/**
 * OPE-266 — site CTR must be read from the UNFILTERED daily totals.
 *
 * The KPI previously divided `getSiteSearchQueries(rowLimit: 500).totals`, a
 * query-dimensioned subset, and reported it as the site's CTR. It sat RED for
 * nine days at 1.71% against a ≥2.0% target and auto-filed a dev day of work.
 * Measured afterwards against `gsc_daily_totals` over the KPI's own 7-day
 * stable window, CTR was 2.36–2.47% throughout — never below target.
 *
 * Source-level, because the property is "this function reads that table and not
 * that API", which no amount of mocking expresses as directly. Same pattern as
 * `dedup-sees-nonpublic-events.test.ts`.
 */
describe("OPE-266 — site_ctr reads the unfiltered series", () => {
  const SOURCE = readFileSync(resolve(__dirname, "..", "kpi-states.ts"), "utf8");
  const readSiteCtrBody = SOURCE.slice(
    SOURCE.indexOf("async function readSiteCtr("),
    SOURCE.indexOf("async function readConversionRate(")
  );

  it("reads gscDailyTotals", () => {
    expect(readSiteCtrBody).toContain("gscDailyTotals");
  });

  it("does NOT compute CTR from a query-dimensioned request", () => {
    // The specific defect: `getSiteSearchQueries` returns the top N QUERIES and
    // its `totals` cover only those rows, so dividing them describes a subset,
    // not the site. `readBrandShare` still uses that call and is correct to —
    // it sums numerator and denominator from the same returned rows, and brand
    // share genuinely requires the query dimension.
    expect(readSiteCtrBody).not.toContain("getSiteSearchQueries");
  });

  it("returns null, not zero, when the window has no rows", () => {
    // A missing ingest must not classify as RED. Returning 0 would invent a
    // crisis out of an absent feed — the same shape as the defect above, and
    // the reason the guard is explicit rather than incidental.
    expect(readSiteCtrBody).toContain("no gsc_daily_totals rows in window");
    expect(readSiteCtrBody).toContain("value: null");
  });
});

describe("OPE-266 — a null value must not read as a crisis", () => {
  it("does not classify null as RED", () => {
    const r = decideStateRow("site_ctr", null, FRESH, undefined, NOW);
    expect(r.state).not.toBe("RED");
  });
});
