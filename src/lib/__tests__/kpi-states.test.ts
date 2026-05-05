/**
 * State-transition tests for the §6.3 KPI state machine. Tests the pure
 * `decideStateRow` helper extracted from `recomputeKpiStates` — no D1 mocking
 * needed; the IO portion is exercised through the integration smoke (cron
 * fires + admin/analytics page renders new states).
 */
import { describe, it, expect } from "vitest";
import { decideStateRow } from "../kpi-states";

const NOW = new Date("2026-05-05T12:00:00Z");
const EARLIER = new Date("2026-05-01T12:00:00Z");

describe("decideStateRow", () => {
  it("first run (no previous) marks state_changed and sets firstDetected to now", () => {
    const r = decideStateRow("site_ctr", 0.005, undefined, NOW);
    expect(r.state).toBe("RED");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(false);
  });

  it("sustained RED carries forward firstDetectedAt", () => {
    const r = decideStateRow("site_ctr", 0.005, { state: "RED", firstDetectedAt: EARLIER }, NOW);
    expect(r.state).toBe("RED");
    expect(r.stateChangedFromPrevious).toBe(false);
    expect(r.firstDetectedAt).toEqual(EARLIER);
    expect(r.isResolution).toBe(false);
  });

  it("RED → YELLOW resets firstDetectedAt; not a resolution", () => {
    const r = decideStateRow("site_ctr", 0.015, { state: "RED", firstDetectedAt: EARLIER }, NOW);
    expect(r.state).toBe("YELLOW");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(false);
  });

  it("RED → GREEN counts as a resolution", () => {
    const r = decideStateRow("site_ctr", 0.025, { state: "RED", firstDetectedAt: EARLIER }, NOW);
    expect(r.state).toBe("GREEN");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.firstDetectedAt).toEqual(NOW);
    expect(r.isResolution).toBe(true);
  });

  it("YELLOW → GREEN counts as a resolution", () => {
    const r = decideStateRow(
      "conversion_rate",
      0.09,
      { state: "YELLOW", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.isResolution).toBe(true);
  });

  it("GREEN → RED is a transition but not a resolution", () => {
    const r = decideStateRow("site_ctr", 0.005, { state: "GREEN", firstDetectedAt: EARLIER }, NOW);
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
      { state: "RED", firstDetectedAt: EARLIER },
      NOW
    );
    expect(r.state).toBe("INDETERMINATE");
    expect(r.stateChangedFromPrevious).toBe(true);
    expect(r.isResolution).toBe(false);
  });
});
