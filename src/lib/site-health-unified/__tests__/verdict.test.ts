import { describe, it, expect } from "vitest";
import { computeSiteHealthVerdict, type InstrumentReading } from "../verdict";
import { technicalReading, dataReading, trafficReading } from "../readings";
import type { DataHealthReport } from "../data-health";

const ok = (key: InstrumentReading["key"], label: string): InstrumentReading => ({
  key,
  label,
  severity: "ok",
  actionItems: 0,
  detail: `${label} fine`,
});

describe("computeSiteHealthVerdict — an unmeasured instrument is never healthy", () => {
  it("says Healthy only when every instrument reported ok", () => {
    const v = computeSiteHealthVerdict([
      ok("technical", "Technical"),
      ok("data", "Data"),
      ok("traffic", "Traffic"),
    ]);
    expect(v.status).toBe("healthy");
    expect(v.headline).toContain("Healthy");
  });

  it("refuses Healthy when ONE instrument could not be measured", () => {
    // The defect this whole file exists to prevent: a health page rendering
    // green because its data source is down.
    const v = computeSiteHealthVerdict([
      ok("technical", "Technical"),
      ok("data", "Data"),
      {
        key: "traffic",
        label: "Traffic",
        severity: "unknown",
        actionItems: null,
        detail: "GA4 down",
      },
    ]);
    expect(v.status).toBe("unknown");
    expect(v.status).not.toBe("healthy");
    expect(v.headline).toContain("Traffic");
    expect(v.unmeasured).toEqual(["Traffic"]);
  });

  it("refuses Healthy when NOTHING reported at all", () => {
    const v = computeSiteHealthVerdict([]);
    expect(v.status).toBe("unknown");
    expect(v.headline).toContain("nothing has been measured");
  });

  it("lets a real problem outrank an unmeasured instrument", () => {
    // 'unknown' must not drown out an actionable defect — a named failure is
    // the more useful headline than "we could not check something else".
    const v = computeSiteHealthVerdict([
      {
        key: "technical",
        label: "Technical",
        severity: "critical",
        actionItems: 3,
        detail: "3 pages 5xx",
      },
      {
        key: "traffic",
        label: "Traffic",
        severity: "unknown",
        actionItems: null,
        detail: "GA4 down",
      },
    ]);
    expect(v.status).toBe("critical");
    expect(v.headline).toContain("3 pages 5xx");
    // …but the gap is still disclosed, not dropped.
    expect(v.headline).toContain("Traffic");
  });

  it("ranks critical above attention", () => {
    const v = computeSiteHealthVerdict([
      { key: "data", label: "Data", severity: "attention", actionItems: 12, detail: "12 open" },
      {
        key: "technical",
        label: "Technical",
        severity: "critical",
        actionItems: 1,
        detail: "1 error",
      },
    ]);
    expect(v.status).toBe("critical");
    // Worst first, so the lead clause is the thing that matters most.
    expect(v.problems[0].key).toBe("technical");
  });

  it("does not let a large benign count outrank a single real defect", () => {
    // Status is the worst SEVERITY, never the biggest COUNT. If 200 expected
    // notices outranked one 5xx the banner would train the reader to ignore it.
    const v = computeSiteHealthVerdict([
      { key: "data", label: "Data", severity: "attention", actionItems: 200, detail: "200 open" },
      {
        key: "technical",
        label: "Technical",
        severity: "critical",
        actionItems: 1,
        detail: "1 error",
      },
    ]);
    expect(v.status).toBe("critical");
  });

  it("counts action items only from instruments that reported one", () => {
    const v = computeSiteHealthVerdict([
      { key: "technical", label: "Technical", severity: "attention", actionItems: 2, detail: "2" },
      { key: "traffic", label: "Traffic", severity: "unknown", actionItems: null, detail: "down" },
    ]);
    expect(v.totalActionItems).toBe(2);
  });

  it("pluralises the action-item count", () => {
    const one = computeSiteHealthVerdict([
      { key: "technical", label: "T", severity: "attention", actionItems: 1, detail: "d" },
    ]);
    expect(one.headline).toContain("1 action item:");
    expect(one.headline).not.toContain("1 action items");
  });
});

const trend = (values: number[]) =>
  values.map((v, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    openCount: v,
    outreachCandidates: 0,
    weightedPrioritySum: 0,
  }));

const baseData = (over: Partial<DataHealthReport> = {}): DataHealthReport => ({
  liveOpen: 264,
  liveOutreachCandidates: 130,
  liveWeightedPriority: 161.4,
  resolutions: {
    adjudicated: 45,
    superseded: 6994,
    dismissed: 7,
    resolvedAuthoritative: 33,
    resolvedDivergent: 5,
    selfResolved: 7,
    resolvedLegacy: 7039,
    adjudicatedCoverage: 45 / 52,
    legacyCoverage: 7039 / 7046,
  },
  operatorOverrides28d: 0,
  trend: trend([260, 262, 264]),
  latestSnapshotDate: "2026-08-30",
  latestSnapshotAgeDays: 0,
  snapshotStale: false,
  liveVsSnapshotDelta: 1,
  ...over,
});

describe("readings", () => {
  it("technical: an ERROR is critical, a WARNING is only attention", () => {
    expect(
      technicalReading({ errorCount: 1, warningCount: 0, richResultFailCount: 0 }).severity
    ).toBe("critical");
    expect(
      technicalReading({ errorCount: 0, warningCount: 3, richResultFailCount: 0 }).severity
    ).toBe("attention");
    expect(
      technicalReading({ errorCount: 0, warningCount: 0, richResultFailCount: 0 }).severity
    ).toBe("ok");
  });

  it("technical: leads with the rich-result count when there is one", () => {
    const r = technicalReading({ errorCount: 0, warningCount: 2, richResultFailCount: 2 });
    expect(r.detail).toBe("2 pages failing rich-result validation");
    expect(r.actionItems).toBe(2);
  });

  it("technical: names the remainder when other issues sit alongside", () => {
    const r = technicalReading({ errorCount: 0, warningCount: 3, richResultFailCount: 1 });
    expect(r.detail).toContain("1 page failing rich-result validation");
    expect(r.detail).toContain("2 other technical issues");
  });

  it("data: a GROWING queue is attention, a shrinking one is not", () => {
    // No absolute threshold — the CPI phase-0 target lives in a config file
    // that is not in this repo, so the trend is the honest signal.
    expect(dataReading(baseData({ trend: trend([200, 230, 264]) })).severity).toBe("attention");
    expect(dataReading(baseData({ trend: trend([300, 280, 264]) })).severity).toBe("ok");
    expect(dataReading(baseData({ trend: trend([264, 264, 264]) })).severity).toBe("ok");
  });

  it("data: a stale snapshot is attention even while the queue shrinks", () => {
    const r = dataReading(
      baseData({ trend: trend([300, 280, 264]), snapshotStale: true, latestSnapshotAgeDays: 6 })
    );
    expect(r.severity).toBe("attention");
    expect(r.detail).toContain("6 days stale");
    // The live count is still reported — staleness affects the trend, not it.
    expect(r.actionItems).toBe(264);
  });

  it("data: says so plainly when no snapshot has ever been written", () => {
    const r = dataReading(
      baseData({ snapshotStale: true, latestSnapshotAgeDays: null, latestSnapshotDate: null })
    );
    expect(r.detail).toContain("no health snapshot has ever been written");
  });

  it("traffic: a null session count is UNKNOWN, not zero and not ok", () => {
    const r = trafficReading({
      windowDays: 7,
      current: null,
      previous: null,
      deltaPct: null,
      windowEndDate: "2026-08-28",
    });
    expect(r.severity).toBe("unknown");
    expect(r.actionItems).toBeNull();
    expect(r.detail).not.toContain("0 organic");
  });

  it("traffic: zero measured sessions is a REAL zero, distinct from unknown", () => {
    // The pair that matters: 0 and null must not collapse into the same state.
    const r = trafficReading({
      windowDays: 7,
      current: 0,
      previous: 0,
      deltaPct: null,
      windowEndDate: "2026-08-28",
    });
    expect(r.severity).toBe("ok");
    expect(r.actionItems).toBe(0);
  });

  it("traffic: flags a steep week-over-week fall, tolerates a mild one", () => {
    const at = (deltaPct: number) =>
      trafficReading({
        windowDays: 7,
        current: 100,
        previous: 200,
        deltaPct,
        windowEndDate: "2026-08-28",
      }).severity;
    expect(at(-0.3)).toBe("attention");
    expect(at(-0.25)).toBe("attention"); // boundary is inclusive
    expect(at(-0.24)).toBe("ok");
    expect(at(0.5)).toBe("ok");
  });
});
