/**
 * OPE-225 — the photo-coverage model.
 *
 * The load-bearing behaviour is `reconcileCoverageRow`: because there is ONE
 * observer rather than 108 writers, every claim the OPE-226 scorecard will make
 * about "images added since baseline" rests on these three rules.
 */
import { describe, it, expect } from "vitest";
import {
  classifyImageUrlHealth,
  demandTierFor,
  rankImagelessByDemand,
  reconcileCoverageRow,
  summarizeCoverage,
  type CoverageObservation,
  type CoverageStateRow,
} from "../model";

const T0 = new Date("2026-07-20T00:00:00Z");
const T1 = new Date("2026-07-21T00:00:00Z");
const T2 = new Date("2026-07-22T00:00:00Z");

const obs = (over: Partial<CoverageObservation> = {}): CoverageObservation => ({
  entityType: "EVENT",
  entityId: "e1",
  slug: "fryeburg-fair",
  imageUrl: null,
  demandImpressions: 0,
  ...over,
});

describe("classifyImageUrlHealth", () => {
  it("treats our own CDN and apex as OWNED", () => {
    expect(classifyImageUrlHealth("https://cdn.meetmeatthefair.com/events/a/hero.webp")).toBe(
      "OWNED"
    );
    expect(classifyImageUrlHealth("https://meetmeatthefair.com/img/x.jpg")).toBe("OWNED");
    expect(classifyImageUrlHealth("/uploads/x.jpg")).toBe("OWNED");
  });

  it("flags a third-party URL as HOTLINKED (the audit's 24 events)", () => {
    expect(classifyImageUrlHealth("https://fryeburgfair.org/wp/hero.jpg")).toBe("HOTLINKED");
  });

  it("treats blank/whitespace as MISSING, not as a URL", () => {
    expect(classifyImageUrlHealth(null)).toBe("MISSING");
    expect(classifyImageUrlHealth("")).toBe("MISSING");
    expect(classifyImageUrlHealth("   ")).toBe("MISSING");
  });
});

describe("demandTierFor", () => {
  it("buckets on 28-day impressions", () => {
    expect(demandTierFor(5000)).toBe("T1");
    expect(demandTierFor(500)).toBe("T1"); // boundary is inclusive
    expect(demandTierFor(499)).toBe("T2");
    expect(demandTierFor(100)).toBe("T2");
    expect(demandTierFor(99)).toBe("T3");
    expect(demandTierFor(1)).toBe("T3");
  });

  it("puts zero-demand pages in T4 — 'not measured', not 'worthless'", () => {
    expect(demandTierFor(0)).toBe("T4");
  });
});

describe("reconcileCoverageRow", () => {
  it("rule 1 — a first sighting WITH an image is baseline, imageSetAt stays NULL", () => {
    const row = reconcileCoverageRow(null, obs({ imageUrl: "https://x.test/a.jpg" }), T0);
    expect(row.hasImage).toBe(true);
    expect(row.baselineHadImage).toBe(true);
    // Stamping T0 here would manufacture a lift window that never happened.
    expect(row.imageSetAt).toBeNull();
  });

  it("rule 1 — a first sighting WITHOUT an image is baseline too", () => {
    const row = reconcileCoverageRow(null, obs(), T0);
    expect(row.hasImage).toBe(false);
    expect(row.baselineHadImage).toBe(false);
    expect(row.imageSetAt).toBeNull();
  });

  it("rule 2 — gaining an image stamps imageSetAt", () => {
    const before = reconcileCoverageRow(null, obs(), T0);
    const after = reconcileCoverageRow(
      before,
      obs({ imageUrl: "https://cdn.meetmeatthefair.com/e/a.webp" }),
      T1
    );
    expect(after.hasImage).toBe(true);
    expect(after.imageSetAt).toEqual(T1);
    expect(after.baselineHadImage).toBe(false); // it did NOT have one at baseline
  });

  it("rule 3 — swapping one image for another does NOT re-stamp", () => {
    const t0 = reconcileCoverageRow(null, obs(), T0);
    const t1 = reconcileCoverageRow(t0, obs({ imageUrl: "https://a.test/1.jpg" }), T1);
    const t2 = reconcileCoverageRow(t1, obs({ imageUrl: "https://a.test/2.jpg" }), T2);
    // Re-stamping would silently reset an in-flight lift measurement.
    expect(t2.imageSetAt).toEqual(T1);
  });

  it("a baseline-image entity never acquires an imageSetAt, even later", () => {
    const base = reconcileCoverageRow(null, obs({ imageUrl: "https://a.test/1.jpg" }), T0);
    const later = reconcileCoverageRow(base, obs({ imageUrl: "https://a.test/2.jpg" }), T2);
    expect(later.imageSetAt).toBeNull();
    expect(later.baselineHadImage).toBe(true);
  });

  it("losing an image keeps the history but re-enters the queue", () => {
    const t0 = reconcileCoverageRow(null, obs(), T0);
    const t1 = reconcileCoverageRow(t0, obs({ imageUrl: "https://a.test/1.jpg" }), T1);
    const t2 = reconcileCoverageRow(t1, obs({ imageUrl: null }), T2);
    expect(t2.hasImage).toBe(false);
    expect(t2.urlHealth).toBe("MISSING");
    expect(t2.imageSetAt).toEqual(T1); // history preserved
  });

  it("rule 4 — a MEASURED UNREACHABLE survives the daily scan (same URL)", () => {
    // Without this, the nightly scan would re-derive health from the URL string
    // and reset the rot sweep's verdict to OWNED within a day, so UNREACHABLE
    // would never be visible and §4's rot flag would read permanently clean.
    const dead = reconcileCoverageRow(null, obs({ imageUrl: "https://gone.test/a.jpg" }), T0);
    const measured = { ...dead, urlHealth: "UNREACHABLE" as const, urlCheckedAt: T1 };
    const after = reconcileCoverageRow(measured, obs({ imageUrl: "https://gone.test/a.jpg" }), T2);
    expect(after.urlHealth).toBe("UNREACHABLE");
    expect(after.urlCheckedAt).toEqual(T1); // round-robin clock not reset
  });

  it("rule 4 — a CHANGED url drops the stale verdict and re-queues for checking", () => {
    const dead = reconcileCoverageRow(null, obs({ imageUrl: "https://gone.test/a.jpg" }), T0);
    const measured = {
      ...dead,
      urlHealth: "UNREACHABLE" as const,
      urlCheckedAt: T1,
      urlStatusCode: 404,
    };
    const after = reconcileCoverageRow(
      measured,
      obs({ imageUrl: "https://cdn.meetmeatthefair.com/e/new.webp" }),
      T2
    );
    // A brand-new URL has never been checked; carrying the old verdict would
    // report a working image as dead.
    expect(after.urlHealth).toBe("OWNED");
    expect(after.urlCheckedAt).toBeNull();
    expect(after.urlStatusCode).toBeNull();
  });

  it("rule 4 — losing the image entirely clears UNREACHABLE to MISSING", () => {
    const dead = reconcileCoverageRow(null, obs({ imageUrl: "https://gone.test/a.jpg" }), T0);
    const measured = { ...dead, urlHealth: "UNREACHABLE" as const, urlCheckedAt: T1 };
    const after = reconcileCoverageRow(measured, obs({ imageUrl: null }), T2);
    expect(after.urlHealth).toBe("MISSING");
  });

  it("refreshes demand and re-tiers on every observation", () => {
    const t0 = reconcileCoverageRow(null, obs({ demandImpressions: 0 }), T0);
    expect(t0.demandTier).toBe("T4");
    const t1 = reconcileCoverageRow(t0, obs({ demandImpressions: 900 }), T1);
    expect(t1.demandTier).toBe("T1");
    expect(t1.firstSeenAt).toEqual(T0); // first-seen is immutable
  });
});

const row = (over: Partial<CoverageStateRow>): CoverageStateRow => ({
  entityType: "EVENT",
  entityId: "e",
  hasImage: false,
  imageUrl: null,
  urlHealth: "MISSING",
  imageSetAt: null,
  baselineHadImage: false,
  firstSeenAt: T0,
  demandImpressions: 0,
  demandTier: "T4",
  checkedAt: T0,
  urlCheckedAt: null,
  urlStatusCode: null,
  ...over,
});

describe("summarizeCoverage", () => {
  it("slices by tier so 'high-traffic imageless' is visible, not averaged away", () => {
    // The audit's actual shape: overall coverage looks OK, T1 is empty.
    const rows = [
      row({ entityId: "hi1", demandTier: "T1", hasImage: false }),
      row({ entityId: "hi2", demandTier: "T1", hasImage: false }),
      row({ entityId: "lo1", demandTier: "T4", hasImage: true, urlHealth: "OWNED" }),
      row({ entityId: "lo2", demandTier: "T4", hasImage: true, urlHealth: "OWNED" }),
      row({ entityId: "lo3", demandTier: "T4", hasImage: true, urlHealth: "OWNED" }),
    ];
    const events = summarizeCoverage(rows).find((e) => e.entityType === "EVENT")!;

    expect(events.total).toBe(5);
    expect(events.coveragePct).toBe(60); // the flattering headline number
    const t1 = events.byTier.find((t) => t.tier === "T1")!;
    expect(t1.total).toBe(2);
    expect(t1.coveragePct).toBe(0); // the number that actually matters
  });

  it("always emits every tier, including empty ones", () => {
    const events = summarizeCoverage([row({})]).find((e) => e.entityType === "EVENT")!;
    expect(events.byTier.map((t) => t.tier)).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("always emits every entity type, so an unscanned one reads as 0/0 not absent", () => {
    expect(summarizeCoverage([]).map((e) => e.entityType)).toEqual([
      "EVENT",
      "VENDOR",
      "VENUE",
      "PROMOTER",
      "PERFORMER",
    ]);
  });

  it("counts hotlinks and images-added-since-baseline separately", () => {
    const rows = [
      row({ entityId: "a", hasImage: true, urlHealth: "HOTLINKED" }),
      row({ entityId: "b", hasImage: true, urlHealth: "OWNED", imageSetAt: T1 }),
      row({ entityId: "c", hasImage: true, urlHealth: "OWNED", baselineHadImage: true }),
    ];
    const events = summarizeCoverage(rows).find((e) => e.entityType === "EVENT")!;
    expect(events.hotlinked).toBe(1);
    expect(events.addedSinceBaseline).toBe(1); // only b — c was pre-existing
  });
});

describe("rankImagelessByDemand", () => {
  it("returns only imageless entities, highest demand first", () => {
    const rows = [
      row({ entityId: "low", demandImpressions: 10 }),
      row({ entityId: "high", demandImpressions: 900 }),
      row({ entityId: "covered", demandImpressions: 5000, hasImage: true }),
    ];
    expect(rankImagelessByDemand(rows, 10).map((r) => r.entityId)).toEqual(["high", "low"]);
  });

  it("breaks ties stably so paging can't oscillate", () => {
    const rows = [
      row({ entityId: "b", demandImpressions: 5 }),
      row({ entityId: "a", demandImpressions: 5 }),
    ];
    expect(rankImagelessByDemand(rows, 10).map((r) => r.entityId)).toEqual(["a", "b"]);
  });

  it("honours the limit", () => {
    const rows = [
      row({ entityId: "a", demandImpressions: 3 }),
      row({ entityId: "b", demandImpressions: 2 }),
    ];
    expect(rankImagelessByDemand(rows, 1)).toHaveLength(1);
  });
});
