import { describe, expect, it } from "vitest";
import type { CoverageStateRow, DemandTier, PhotoEntityType } from "@/lib/photo-coverage/model";
import {
  COVERAGE_REGRESSION_PP,
  aggregateLift,
  buildCoverageTrend,
  buildSnapshotRows,
  detectPhotoRegressions,
  latestDate,
  liftNote,
  unmeasuredTypes,
  windowMetrics,
  type PageWindowSums,
  type SnapshotPoint,
} from "../model";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function row(
  entityType: PhotoEntityType,
  opts: Partial<CoverageStateRow> & { tier?: DemandTier } = {}
): CoverageStateRow {
  return {
    entityType,
    entityId: opts.entityId ?? Math.random().toString(36).slice(2),
    hasImage: opts.hasImage ?? false,
    imageUrl: opts.imageUrl ?? null,
    urlHealth: opts.urlHealth ?? "MISSING",
    imageSetAt: opts.imageSetAt ?? null,
    baselineHadImage: opts.baselineHadImage ?? false,
    firstSeenAt: opts.firstSeenAt ?? NOW,
    demandImpressions: opts.demandImpressions ?? 0,
    demandTier: opts.tier ?? opts.demandTier ?? "T4",
    checkedAt: opts.checkedAt ?? NOW,
    urlCheckedAt: opts.urlCheckedAt ?? null,
    urlStatusCode: opts.urlStatusCode ?? null,
  };
}

function point(over: Partial<SnapshotPoint> = {}): SnapshotPoint {
  return {
    date: "2026-07-21",
    entityType: "EVENT",
    demandTier: "T4",
    total: 0,
    withImage: 0,
    hotlinked: 0,
    unreachable: 0,
    addedSinceBaseline: 0,
    scanComplete: true,
    ...over,
  };
}

describe("buildSnapshotRows — absent is not zero", () => {
  it("emits no rows at all for an entity type that was never observed", () => {
    // The exact prod shape on 2026-07-21: the scan wrote events and part of
    // vendors, then died. Venues/promoters/performers must be ABSENT, not 0/0.
    const rows = [row("EVENT", { hasImage: true }), row("VENDOR")];
    const out = buildSnapshotRows(rows, "2026-07-21", false);

    const types = new Set(out.map((p) => p.entityType));
    expect(types).toEqual(new Set(["EVENT", "VENDOR"]));
    expect(out.some((p) => p.entityType === "VENUE")).toBe(false);
  });

  it("emits all four tiers for a type that WAS observed, including empty ones", () => {
    const out = buildSnapshotRows([row("EVENT", { tier: "T1" })], "2026-07-21", true);
    const events = out.filter((p) => p.entityType === "EVENT");
    expect(events.map((p) => p.demandTier).sort()).toEqual(["T1", "T2", "T3", "T4"]);
    // A tier with no entities inside a measured type is genuinely zero.
    expect(events.find((p) => p.demandTier === "T2")?.total).toBe(0);
  });

  it("counts image, hotlink, unreachable and lift-eligible populations per tier", () => {
    const rows = [
      row("EVENT", { tier: "T1", hasImage: true, urlHealth: "OWNED", imageSetAt: NOW }),
      row("EVENT", { tier: "T1", hasImage: true, urlHealth: "HOTLINKED" }),
      row("EVENT", { tier: "T1", hasImage: true, urlHealth: "UNREACHABLE" }),
      row("EVENT", { tier: "T1" }),
    ];
    const t1 = buildSnapshotRows(rows, "2026-07-21", true).find((p) => p.demandTier === "T1")!;
    expect(t1).toMatchObject({
      total: 4,
      withImage: 3,
      hotlinked: 1,
      unreachable: 1,
      addedSinceBaseline: 1,
    });
  });

  it("carries the scan-complete flag onto every row it writes", () => {
    const out = buildSnapshotRows([row("EVENT")], "2026-07-21", false);
    expect(out.every((p) => p.scanComplete === false)).toBe(true);
  });
});

describe("unmeasuredTypes", () => {
  it("names the types missing from the newest date", () => {
    const points = [
      point({ date: "2026-07-21", entityType: "EVENT" }),
      point({ date: "2026-07-21", entityType: "VENDOR" }),
    ];
    expect(unmeasuredTypes(points)).toEqual(["VENUE", "PROMOTER", "PERFORMER"]);
  });

  it("ignores a type that was present on an OLDER date but is missing now", () => {
    // Regression guard: a type dropping out is precisely the signal, so an
    // older row must not mask today's absence.
    const points = [
      point({ date: "2026-07-20", entityType: "VENUE" }),
      point({ date: "2026-07-21", entityType: "EVENT" }),
    ];
    expect(unmeasuredTypes(points)).toContain("VENUE");
  });

  it("reports every type as unmeasured when there are no snapshots at all", () => {
    expect(unmeasuredTypes([])).toHaveLength(5);
  });

  it("latestDate returns null on an empty series", () => {
    expect(latestDate([])).toBeNull();
  });
});

describe("buildCoverageTrend", () => {
  it("excludes days whose scan did not complete", () => {
    const points = [
      point({ date: "2026-07-20", total: 100, withImage: 50, scanComplete: true }),
      // A truncated day looks like a coverage cliff; it must not enter the series.
      point({ date: "2026-07-21", total: 10, withImage: 1, scanComplete: false }),
    ];
    const [ev] = buildCoverageTrend(points);
    expect(ev.total).toBe(100);
    expect(ev.coveragePct).toBe(50);
  });

  it("computes the type-level delta from totals, not an average of tier percentages", () => {
    // T4 holds 1000 rows at 10%; T1 holds 2 rows at 100%. Averaging the tier
    // percentages would report 55%; the honest figure is 10.2%.
    const mk = (date: string, withImage: number) => [
      point({ date, demandTier: "T1", total: 2, withImage: 2 }),
      point({ date, demandTier: "T4", total: 1000, withImage }),
    ];
    const [ev] = buildCoverageTrend([...mk("2026-07-01", 100), ...mk("2026-07-21", 200)]);
    expect(ev.coveragePct).toBeCloseTo(20.2, 1);
    expect(ev.deltaPp).toBeCloseTo(10, 1);
  });

  it("returns no trend rows for a type with no complete-scan data", () => {
    const points = [point({ entityType: "VENUE", scanComplete: false })];
    expect(buildCoverageTrend(points)).toHaveLength(0);
  });
});

describe("aggregateLift — within-page before/after", () => {
  const page = (over: Partial<PageWindowSums> = {}): PageWindowSums => ({
    entityType: "EVENT",
    entityId: "e1",
    slug: "some-fair",
    url: "https://meetmeatthefair.com/events/some-fair",
    imageSetAt: new Date("2026-06-01T00:00:00.000Z"),
    before: windowMetrics(10, 1000),
    after: windowMetrics(20, 1000),
    matured: true,
    ...over,
  });

  it("counts only matured pages in the aggregate", () => {
    const block = aggregateLift([page(), page({ entityId: "e2", matured: false })], 2);
    expect(block.eligible).toBe(2);
    expect(block.matured).toBe(1);
    expect(block.aggregate?.pages).toBe(1);
  });

  it("returns a null aggregate — not a zero — when nothing has matured", () => {
    // A zero here would read as "we measured, and photos did nothing".
    const block = aggregateLift([page({ matured: false })], 1);
    expect(block.aggregate).toBeNull();
    expect(block.note).toContain("no lift is claimed");
  });

  it("recomputes aggregate CTR from summed totals, never averaging per-page CTRs", () => {
    // Page A: 1/1000 = 0.1%. Page B: 50/100 = 50%. Mean-of-CTRs = 25.05%;
    // the correct pooled CTR is 51/1100 = 4.64%.
    const block = aggregateLift(
      [
        page({ entityId: "a", before: windowMetrics(0, 1000), after: windowMetrics(1, 1000) }),
        page({ entityId: "b", before: windowMetrics(0, 100), after: windowMetrics(50, 100) }),
      ],
      2
    );
    expect(block.aggregate?.after.ctr).toBeCloseTo(51 / 1100, 4);
  });

  it("reports a negative move honestly rather than clamping at zero", () => {
    const block = aggregateLift(
      [page({ before: windowMetrics(50, 1000), after: windowMetrics(10, 1000) })],
      1
    );
    expect(block.aggregate!.ctrDeltaPp).toBeLessThan(0);
    expect(block.aggregate!.clicksDelta).toBe(-40);
  });

  it("sorts per-page detail by the size of the move, either direction", () => {
    const block = aggregateLift(
      [
        page({
          entityId: "small",
          before: windowMetrics(10, 1000),
          after: windowMetrics(11, 1000),
        }),
        page({ entityId: "big", before: windowMetrics(10, 1000), after: windowMetrics(200, 1000) }),
      ],
      2
    );
    expect(block.pages[0].entityId).toBe("big");
  });
});

describe("liftNote — the sample size travels with the number", () => {
  it("distinguishes 'nothing eligible' from 'nothing matured' from 'thin'", () => {
    expect(liftNote(0, 0, 28)).toContain("nothing with a before/after boundary");
    expect(liftNote(5, 0, 28)).toContain("none has a full 28-day");
    expect(liftNote(20, 3, 28)).toContain("too few to support a directional conclusion");
    expect(liftNote(40, 30, 28)).toContain("30 matured page(s)");
  });
});

describe("detectPhotoRegressions", () => {
  it("fires when entity types are missing from the newest snapshot", () => {
    const reds = detectPhotoRegressions({ points: [point({ entityType: "EVENT" })] }, NOW);
    const red = reds.find((r) => r.refKey === "photo-effectiveness:unmeasured-types");
    expect(red).toBeDefined();
    expect(red!.title).toContain("VENUE");
  });

  it("fires when the latest scan reported incomplete", () => {
    const reds = detectPhotoRegressions(
      {
        points: [point({ scanComplete: false })],
        expectedTypes: ["EVENT"],
      },
      NOW
    );
    expect(reds.some((r) => r.refKey === "photo-effectiveness:scan-incomplete")).toBe(true);
  });

  it("fires on a real coverage drop past the threshold", () => {
    const points = [
      point({ date: "2026-07-01", total: 100, withImage: 60 }),
      point({ date: "2026-07-21", total: 100, withImage: 40 }),
    ];
    const reds = detectPhotoRegressions({ points, expectedTypes: ["EVENT"] }, NOW);
    const drop = reds.find((r) => r.refKey === "photo-effectiveness:coverage-drop:EVENT");
    expect(drop).toBeDefined();
    expect(drop!.title).toContain("20pp");
  });

  it("stays quiet on a coverage drop smaller than the threshold", () => {
    const points = [
      point({ date: "2026-07-01", total: 100, withImage: 50 }),
      point({ date: "2026-07-21", total: 100, withImage: 50 - (COVERAGE_REGRESSION_PP - 1) }),
    ];
    const reds = detectPhotoRegressions({ points, expectedTypes: ["EVENT"] }, NOW);
    expect(reds.some((r) => r.refKey.startsWith("photo-effectiveness:coverage-drop"))).toBe(false);
  });

  it("stays quiet on a healthy, complete, fully-measured snapshot", () => {
    const points = (["EVENT", "VENDOR", "VENUE", "PROMOTER", "PERFORMER"] as const).map((t) =>
      point({ entityType: t, total: 10, withImage: 5 })
    );
    expect(detectPhotoRegressions({ points }, NOW)).toEqual([]);
  });

  it("returns nothing when there are no snapshots yet, rather than a false red", () => {
    expect(detectPhotoRegressions({ points: [] }, NOW)).toEqual([]);
  });
});
