import { describe, it, expect } from "vitest";
import { unsafeSlug } from "@takemetothefair/utils";
import { selectCommittableGroups } from "../commit-selection";
import type { SeriesGroup } from "../group-events";

// Minimal SeriesGroup builder — only the fields selection reads. canonicalSlug
// is branded after the spread so call sites can pass a plain string.
const g = (
  over: { canonicalSlug: string } & Partial<Omit<SeriesGroup, "canonicalSlug">>
): SeriesGroup => ({
  stem: over.canonicalSlug,
  venueId: "v1",
  members: [],
  isMultiOccurrence: false,
  vendorBearing: false,
  needsManualConfirm: false,
  sameYearConflict: false,
  defaultsFromId: "x",
  ...over,
  canonicalSlug: unsafeSlug(over.canonicalSlug),
});

const slugs = (xs: { canonicalSlug: string }[]) => xs.map((x) => x.canonicalSlug);

describe("selectCommittableGroups", () => {
  it("commits an ordinary singleton/series group", () => {
    const sel = selectCommittableGroups([g({ canonicalSlug: "vermont-brewers-festival" })]);
    expect(slugs(sel.commit)).toEqual(["vermont-brewers-festival"]);
    expect(sel.skipped).toEqual([]);
  });

  it("skips a group whose series already exists (idempotent re-run)", () => {
    const sel = selectCommittableGroups([g({ canonicalSlug: "fryeburg-fair" })], {
      existingSeriesSlugs: ["fryeburg-fair"],
    });
    expect(sel.commit).toEqual([]);
    expect(sel.skipped).toEqual([{ canonicalSlug: "fryeburg-fair", reason: "already-exists" }]);
  });

  it("holds a same-year-conflict group for merge_events", () => {
    const sel = selectCommittableGroups([
      g({ canonicalSlug: "fryeburg-fair", sameYearConflict: true }),
    ]);
    expect(sel.commit).toEqual([]);
    expect(sel.skipped[0].reason).toBe("same-year-conflict");
  });

  it("holds a vendor-bearing multi-occurrence group unless explicitly confirmed", () => {
    const grp = g({
      canonicalSlug: "newport-international-boat-show",
      isMultiOccurrence: true,
      vendorBearing: true,
      needsManualConfirm: true,
    });
    // Unconfirmed → held.
    expect(selectCommittableGroups([grp]).skipped[0].reason).toBe("needs-manual-confirm");
    // Confirmed → commits.
    const sel = selectCommittableGroups([grp], {
      confirmedSlugs: ["newport-international-boat-show"],
    });
    expect(slugs(sel.commit)).toEqual(["newport-international-boat-show"]);
    expect(sel.skipped).toEqual([]);
  });

  it("already-exists takes precedence over a confirm/same-year hold", () => {
    const grp = g({
      canonicalSlug: "newport-international-boat-show",
      needsManualConfirm: true,
      sameYearConflict: true,
    });
    const sel = selectCommittableGroups([grp], {
      existingSeriesSlugs: ["newport-international-boat-show"],
      confirmedSlugs: ["newport-international-boat-show"],
    });
    expect(sel.skipped[0].reason).toBe("already-exists");
  });

  it("holds BOTH groups when two committable groups collide on canonical_slug", () => {
    // Same stem at two different venues, neither with a clean member → both
    // resolve to the same canonical_slug. event_series.canonical_slug is UNIQUE.
    const sel = selectCommittableGroups([
      g({ canonicalSlug: "guilford-fair", venueId: "v-ct" }),
      g({ canonicalSlug: "guilford-fair", venueId: "v-vt" }),
    ]);
    expect(sel.commit).toEqual([]);
    expect(sel.skipped).toEqual([
      { canonicalSlug: "guilford-fair", reason: "canonical-collision" },
      { canonicalSlug: "guilford-fair", reason: "canonical-collision" },
    ]);
  });

  it("commits a unique canonical_slug while holding a colliding pair", () => {
    const sel = selectCommittableGroups([
      g({ canonicalSlug: "unique-fair" }),
      g({ canonicalSlug: "dup-fair", venueId: "a" }),
      g({ canonicalSlug: "dup-fair", venueId: "b" }),
    ]);
    expect(slugs(sel.commit)).toEqual(["unique-fair"]);
    expect(sel.skipped.every((s) => s.reason === "canonical-collision")).toBe(true);
    expect(sel.skipped).toHaveLength(2);
  });

  it("a same-year-held group does not count toward a collision", () => {
    // The same-year group is held BEFORE the collision pass, so the other group
    // with the same slug is alone in commit → it commits.
    const sel = selectCommittableGroups([
      g({ canonicalSlug: "shared", venueId: "a", sameYearConflict: true }),
      g({ canonicalSlug: "shared", venueId: "b" }),
    ]);
    expect(slugs(sel.commit)).toEqual(["shared"]);
    expect(sel.skipped).toEqual([{ canonicalSlug: "shared", reason: "same-year-conflict" }]);
  });

  it("partitions a mixed batch correctly", () => {
    const sel = selectCommittableGroups(
      [
        g({ canonicalSlug: "ok-1" }),
        g({ canonicalSlug: "ok-2" }),
        g({ canonicalSlug: "dup", sameYearConflict: true }),
        g({ canonicalSlug: "vendor", needsManualConfirm: true }),
        g({ canonicalSlug: "exists" }),
      ],
      { existingSeriesSlugs: ["exists"] }
    );
    expect(slugs(sel.commit).sort()).toEqual(["ok-1", "ok-2"]);
    expect(sel.skipped.map((s) => `${s.canonicalSlug}:${s.reason}`).sort()).toEqual([
      "dup:same-year-conflict",
      "exists:already-exists",
      "vendor:needs-manual-confirm",
    ]);
  });
});
