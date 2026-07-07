/**
 * OPE-101 — the canonical slug→cluster map replaces the v1 keyword heuristic.
 * These tests are the BUILD GUARD for map integrity: they fail if the map drifts
 * from the design doc's 113-post shape (count / per-cluster totals / invalid ids),
 * so a bad edit can't ship. (A live "every PUBLISHED post is in the map" check
 * needs prod D1, unavailable in CI — the runtime signal is the `unclustered`
 * bucket surfacing on /admin/blog; see blog-clusters.ts.)
 */
import { describe, expect, it } from "vitest";
import {
  SLUG_TO_CLUSTER,
  CLUSTER_LABELS,
  getCluster,
  getClusterLabel,
  UNCLUSTERED,
  type ClusterId,
} from "../blog-clusters";

// The 12 real clusters + their expected post counts (design §4 group headers).
const EXPECTED_COUNTS: Record<Exclude<ClusterId, "unclustered">, number> = {
  "state-pillars": 7,
  "craft-fairs": 20,
  breweries: 9,
  "gun-shows": 6,
  "big-e": 6,
  renaissance: 6,
  "highland-games": 4,
  "food-festivals": 14,
  "boat-marine": 7,
  "individual-fairs": 12,
  "vendor-resources": 11,
  "visitor-tips": 11,
};

describe("canonical cluster map — build guard (OPE-101)", () => {
  it("maps exactly 113 published posts", () => {
    expect(Object.keys(SLUG_TO_CLUSTER)).toHaveLength(113);
  });

  it("every mapped value is a real (non-unclustered) cluster id", () => {
    for (const [slug, id] of Object.entries(SLUG_TO_CLUSTER)) {
      expect(CLUSTER_LABELS[id], `${slug} → ${id}`).toBeDefined();
      expect(id).not.toBe(UNCLUSTERED);
    }
  });

  it("per-cluster counts match the design doc (§4) and sum to 113", () => {
    const counts: Record<string, number> = {};
    for (const id of Object.values(SLUG_TO_CLUSTER)) counts[id] = (counts[id] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_COUNTS);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(113);
  });

  it("every real cluster id has a display label", () => {
    for (const id of Object.keys(EXPECTED_COUNTS) as ClusterId[]) {
      expect(CLUSTER_LABELS[id]).toBeTruthy();
    }
    expect(CLUSTER_LABELS[UNCLUSTERED]).toBe("Unclustered");
  });
});

describe("getCluster / getClusterLabel (OPE-101)", () => {
  it("fixes the named bug: 'Craft Fairs in Maine' lands in craft-fairs", () => {
    expect(getCluster("craft-fairs-in-maine-2026-a-vendors-and-visitors-guide")).toBe(
      "craft-fairs"
    );
    expect(getClusterLabel("craft-fairs-in-maine-2026-a-vendors-and-visitors-guide")).toBe(
      "Craft fairs & art festivals"
    );
  });

  it("classifies representative posts across clusters", () => {
    expect(getCluster("gun-shows-in-maine-2026-the-complete-schedule-and-guide")).toBe("gun-shows");
    expect(getCluster("the-big-e-your-guide-to-the-eastern-states-exposition-in-2026")).toBe(
      "big-e"
    );
    expect(getCluster("maine-breweries-2026-a-complete-guide-to-portland-and-beyond")).toBe(
      "breweries"
    );
    // A food festival the old heuristic could mis-bucket as a fair guide.
    expect(getCluster("moxie-festival-2026-visitors-guide")).toBe("food-festivals");
  });

  it("an unmapped slug is visibly 'unclustered', never silently mis-bucketed", () => {
    expect(getCluster("some-brand-new-unmapped-post")).toBe(UNCLUSTERED);
    expect(getClusterLabel("some-brand-new-unmapped-post")).toBe("Unclustered");
  });
});
