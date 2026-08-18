/**
 * OPE-378 defect 1 / OPE-458 scope 4 — one submission became several events.
 *
 * Two live specimens:
 *
 *   Waterville Elks  — one craft fair email produced "28th Annual Craft Fair",
 *                      "28th Annual Holiday Craft Fair" (which got the flyer),
 *                      and a third "event" that was really a failed fetch of a
 *                      Facebook link.
 *   Vineyard Artisans — "Vineyard Artisans Festivals" twice, same submitter,
 *                      six seconds apart, second created with a `-2` slug.
 *
 * Why the existing dedup could not catch either: `findDuplicate` bails with
 * `{ isDuplicate: false }` the moment a candidate has no parseable start date,
 * because every name/venue stage needs the date window. `fc2b22bb` had
 * `start_date = NULL` and its twin had a date — same name, same minute,
 * invisible to each other.
 *
 * That guard is correct globally (a nameless-anchor match across the whole
 * catalog is far too loose) and wrong WITHIN one submission, where the shared
 * origin is the anchor.
 */
import { describe, expect, it } from "vitest";
import {
  clusterSubmissionCandidates,
  richness,
  type ClusterableCandidate,
} from "../src/email-handlers/cluster-candidates.js";

describe("the Waterville Elks submission", () => {
  const candidates: ClusterableCandidate[] = [
    { name: "28th Annual Craft Fair", startDate: "2026-11-01" },
    {
      name: "28th Annual Holiday Craft Fair",
      startDate: "2026-11-01",
      imageKey: "flyer.png",
      description: "Waterville Elks Lodge #905, 76 Industrial Street, Waterville, ME. 65 tables.",
    },
  ];

  it("collapses the two records to one", () => {
    // Normalization strips the leading "28th " and "Annual ", so these differ
    // only by the invented "Holiday" — which OPE-378's other half now flags.
    const { kept } = clusterSubmissionCandidates(candidates);
    expect(kept).toHaveLength(1);
  });

  it("keeps the one carrying the flyer", () => {
    // OPE-378 defect 5: the image was bound to only one of the duplicates, so
    // a reviewer keeping the wrong one silently lost it. Richness makes that
    // impossible rather than needing its own rule.
    const { kept } = clusterSubmissionCandidates(candidates);
    expect(kept[0].imageKey).toBe("flyer.png");
  });

  it("reports what it folded away rather than dropping it silently", () => {
    const { collapsed } = clusterSubmissionCandidates(candidates);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].candidate.name).toBe("28th Annual Craft Fair");
  });
});

describe("the Vineyard Artisans pair — the case dedup structurally could not see", () => {
  it("clusters identical names when ONE has no date", () => {
    // This is the whole point. findDuplicate returns false for the dateless
    // one, so the pair could never match globally.
    const { kept, collapsed } = clusterSubmissionCandidates([
      { name: "Vineyard Artisans Festivals", startDate: null },
      { name: "Vineyard Artisans Festivals", startDate: "2024-06-15" },
    ]);
    expect(kept).toHaveLength(1);
    expect(collapsed).toHaveLength(1);
  });

  it("keeps the dated one", () => {
    const { kept } = clusterSubmissionCandidates([
      { name: "Vineyard Artisans Festivals", startDate: null },
      { name: "Vineyard Artisans Festivals", startDate: "2024-06-15" },
    ]);
    expect(kept[0].startDate).toBe("2024-06-15");
  });

  it("keeps the dated one regardless of arrival order", () => {
    const { kept } = clusterSubmissionCandidates([
      { name: "Vineyard Artisans Festivals", startDate: "2024-06-15" },
      { name: "Vineyard Artisans Festivals", startDate: null },
    ]);
    expect(kept[0].startDate).toBe("2024-06-15");
  });
});

describe("what must NEVER be collapsed", () => {
  it("keeps separate editions of a series", () => {
    // OPE-454's multi-show case. Collapsing here would destroy exactly the
    // editions that ticket fought to preserve.
    const { kept } = clusterSubmissionCandidates([
      { name: "Paradise City Arts Festival", startDate: "2027-03-19" },
      { name: "Paradise City Arts Festival", startDate: "2027-05-29" },
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps genuinely different events on the same date", () => {
    const { kept } = clusterSubmissionCandidates([
      { name: "Waterville Craft Fair", startDate: "2026-11-01" },
      { name: "Waterville Antiques Show", startDate: "2026-11-01" },
    ]);
    expect(kept).toHaveLength(2);
  });

  it("passes through candidates with no usable name", () => {
    // Nothing to cluster on; guessing would be worse than a duplicate.
    const { kept } = clusterSubmissionCandidates([
      { name: null, startDate: "2026-11-01" },
      { name: "", startDate: "2026-11-02" },
    ]);
    expect(kept).toHaveLength(2);
  });

  it("collapses a name differing only by a trailing year", () => {
    const { kept } = clusterSubmissionCandidates([
      { name: "Cheshire Fair", startDate: "2026-08-01" },
      { name: "Cheshire Fair 2026", startDate: "2026-08-01" },
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("richness ordering", () => {
  it("ranks a dated candidate above an undated one", () => {
    expect(richness({ startDate: "2026-11-01" })).toBeGreaterThan(richness({ venueName: "X" }));
  });

  it("counts the flyer", () => {
    expect(richness({ imageKey: "f.png" })).toBeGreaterThan(richness({}));
  });

  it("ignores a trivially short description", () => {
    expect(richness({ description: "short" })).toBe(0);
  });
});

describe("degenerate input", () => {
  it("returns an empty result for no candidates", () => {
    expect(clusterSubmissionCandidates([])).toEqual({ kept: [], collapsed: [] });
  });

  it("passes a single candidate straight through", () => {
    const one = [{ name: "Solo Fair", startDate: "2026-11-01" }];
    expect(clusterSubmissionCandidates(one).kept).toEqual(one);
  });
});
