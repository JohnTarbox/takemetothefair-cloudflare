import { describe, it, expect } from "vitest";
import {
  slugStem,
  stripNameEditionSuffix,
  groupEvents,
  findVendorNameCollisions,
  findCanonicalSlugCollisions,
  planSeriesBackfill,
  type GroupableEvent,
} from "../group-events";

// Fixture builder — only override what a test cares about.
let seq = 0;
/**
 * Default the NAME from the slug rather than a constant.
 *
 * OPE-473 added a (normalized name, venue) grouping key alongside the stem
 * key. A fixture that gives every event the literal name "Event" at the same
 * venue therefore fuses corpora that in production have distinct names — which
 * is a property of the fixture, not of the grouper. Deriving the name from the
 * slug keeps each synthetic event as distinguishable as a real one, so a test
 * that means to exercise stem grouping still does.
 */
const nameFromSlug = (slug: string) =>
  slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const mk = (over: Partial<GroupableEvent> = {}): GroupableEvent => ({
  id: over.id ?? `e${seq++}`,
  name: over.name ?? nameFromSlug(over.slug ?? "event"),
  slug: over.slug ?? "event",
  venueId: over.venueId !== undefined ? over.venueId : "v1",
  startDate: over.startDate !== undefined ? over.startDate : new Date(Date.UTC(2026, 0, 1)),
  completenessScore: over.completenessScore ?? 0,
  vendorLinkCount: over.vendorLinkCount ?? 0,
});

const jan = (y: number) => new Date(Date.UTC(y, 0, 1));
const bySlug = (groups: { canonicalSlug: string }[]) => groups.map((g) => g.canonicalSlug);

describe("slugStem", () => {
  it("strips a trailing -YYYY edition suffix", () => {
    expect(slugStem("newport-boat-show-2025")).toBe("newport-boat-show");
    expect(slugStem("midcoast-winter-artisan-fair-2026")).toBe("midcoast-winter-artisan-fair");
    expect(slugStem("old-timers-meet-1999")).toBe("old-timers-meet");
  });
  it("leaves an already-clean slug unchanged", () => {
    expect(slugStem("fryeburg-fair")).toBe("fryeburg-fair");
  });
  it("does not strip a non-year 4-digit suffix", () => {
    expect(slugStem("route-66-rally")).toBe("route-66-rally");
    expect(slugStem("club-1234")).toBe("club-1234"); // 12xx is not 19xx/20xx
  });
  it("strips a full ISO date or year-month suffix (single dated occurrence)", () => {
    expect(slugStem("burlington-summer-farmers-market-2026-09-19")).toBe(
      "burlington-summer-farmers-market"
    );
    expect(slugStem("weekly-market-2026-09")).toBe("weekly-market");
  });
});

describe("stripNameEditionSuffix", () => {
  it("strips a trailing year (with or without a dash separator)", () => {
    expect(stripNameEditionSuffix("Fryeburg Fair 2026")).toBe("Fryeburg Fair");
    expect(stripNameEditionSuffix("Fryeburg Fair - 2026")).toBe("Fryeburg Fair");
  });
  it("strips a trailing em-dash full date (the Burlington case)", () => {
    expect(stripNameEditionSuffix("Burlington Summer Farmers Market — 2026-09-19")).toBe(
      "Burlington Summer Farmers Market"
    );
  });
  it("leaves names with no trailing edition token unchanged", () => {
    expect(stripNameEditionSuffix("Newport Boat Show")).toBe("Newport Boat Show");
    expect(stripNameEditionSuffix("Route 66 Rally")).toBe("Route 66 Rally"); // 66 not a year
  });
  it("does not strip a year that isn't at the end", () => {
    expect(stripNameEditionSuffix("Summer 2026 Kickoff")).toBe("Summer 2026 Kickoff");
  });
  it("returns the original when stripping would empty the name", () => {
    expect(stripNameEditionSuffix("2026")).toBe("2026");
  });
});

describe("groupEvents — keying", () => {
  it("mints a 1:1 series for a singleton (mint-all policy)", () => {
    const [g] = groupEvents([mk({ slug: "vermont-brewers-festival-2026" })]);
    expect(g.members).toHaveLength(1);
    expect(g.isMultiOccurrence).toBe(false);
    expect(g.canonicalSlug).toBe("vermont-brewers-festival");
  });

  it("groups two years of the same event at the same venue", () => {
    const groups = groupEvents([
      mk({ id: "a", slug: "newport-international-boat-show-2025", startDate: jan(2025) }),
      mk({ id: "b", slug: "newport-international-boat-show-2026", startDate: jan(2026) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isMultiOccurrence).toBe(true);
    expect(groups[0].members.map((m) => m.id)).toEqual(["a", "b"]); // year asc
  });

  it("does NOT fuse the same stem at different venues (a miss is cheaper than a fuse)", () => {
    const groups = groupEvents([
      mk({ id: "a", slug: "craft-fair-2026", venueId: "v1" }),
      mk({ id: "b", slug: "craft-fair-2026", venueId: "v2" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("groups NULL-venue events among themselves by stem, separate from venued ones", () => {
    const groups = groupEvents([
      mk({ id: "a", slug: "maine-open-lighthouse-day-2026", venueId: null }),
      mk({ id: "b", slug: "maine-open-lighthouse-day-2027", venueId: null }),
      mk({ id: "c", slug: "maine-open-lighthouse-day-2026", venueId: "v9" }),
    ]);
    // a+b (null venue) form one series; c (venued) is its own.
    expect(groups).toHaveLength(2);
    const multi = groups.find((g) => g.isMultiOccurrence)!;
    expect(multi.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(multi.venueId).toBeNull();
  });
});

describe("groupEvents — canonical slug selection", () => {
  it("prefers an existing clean (un-suffixed) member slug", () => {
    const [g] = groupEvents([
      mk({ slug: "granite-state-fair", startDate: jan(2025) }), // clean member
      mk({ slug: "granite-state-fair-2026", startDate: jan(2026) }),
    ]);
    expect(g.canonicalSlug).toBe("granite-state-fair");
  });

  it("falls back to the bare stem when every member is year-suffixed", () => {
    const [g] = groupEvents([
      mk({ slug: "norwalk-boat-show-2025", startDate: jan(2025) }),
      mk({ slug: "norwalk-boat-show-2026", startDate: jan(2026) }),
    ]);
    expect(g.canonicalSlug).toBe("norwalk-boat-show");
  });
});

describe("groupEvents — fuse-risk flagging (needsManualConfirm)", () => {
  it("flags a vendor-bearing MULTI-occurrence series for manual confirmation", () => {
    const [g] = groupEvents([
      mk({
        id: "a",
        slug: "newport-international-boat-show-2025",
        vendorLinkCount: 383,
        startDate: jan(2025),
      }),
      mk({
        id: "b",
        slug: "newport-international-boat-show-2026",
        vendorLinkCount: 0,
        startDate: jan(2026),
      }),
    ]);
    expect(g.vendorBearing).toBe(true);
    expect(g.needsManualConfirm).toBe(true);
  });

  it("does NOT flag a vendor-bearing SINGLETON — a fuse is structurally impossible", () => {
    const [g] = groupEvents([
      mk({ slug: "suburban-boston-spring-home-show-2026", vendorLinkCount: 1 }),
    ]);
    expect(g.vendorBearing).toBe(true);
    expect(g.isMultiOccurrence).toBe(false);
    expect(g.needsManualConfirm).toBe(false);
  });
});

describe("groupEvents — same-year conflict (flag for merge_events, not co-link)", () => {
  it("flags two members sharing a concrete start-year", () => {
    const [g] = groupEvents([
      mk({ id: "a", slug: "fryeburg-fair", startDate: jan(2026) }),
      mk({ id: "b", slug: "fryeburg-fair-2026", startDate: jan(2026) }),
    ]);
    expect(g.sameYearConflict).toBe(true);
  });

  it("does not flag distinct years", () => {
    const [g] = groupEvents([
      mk({ slug: "leaf-peepers-craft-fair-2025", startDate: jan(2025) }),
      mk({ slug: "leaf-peepers-craft-fair-2026", startDate: jan(2026) }),
    ]);
    expect(g.sameYearConflict).toBe(false);
  });

  it("does not flag when years are unknown (null start dates)", () => {
    const [g] = groupEvents([
      mk({ id: "a", slug: "mystery-fair-2026", startDate: null }),
      mk({ id: "b", slug: "mystery-fair-2027", startDate: null }),
    ]);
    expect(g.sameYearConflict).toBe(false);
  });
});

describe("groupEvents — defaults member selection", () => {
  it("seeds defaults from the highest-completeness member", () => {
    const [g] = groupEvents([
      mk({ id: "lo", slug: "x-2025", completenessScore: 10, startDate: jan(2025) }),
      mk({ id: "hi", slug: "x-2026", completenessScore: 90, startDate: jan(2026) }),
    ]);
    expect(g.defaultsFromId).toBe("hi");
  });

  it("tiebreaks equal completeness toward the clean-slug member", () => {
    const [g] = groupEvents([
      mk({ id: "suffixed", slug: "x-2026", completenessScore: 50, startDate: jan(2026) }),
      mk({ id: "clean", slug: "x", completenessScore: 50, startDate: jan(2025) }),
    ]);
    expect(g.defaultsFromId).toBe("clean");
  });
});

describe("findVendorNameCollisions — slug-drift among vendor groups", () => {
  it("no longer needs flagging when the name key already united them (OPE-473)", () => {
    // "Newport Boat Show" (clean) vs "Annual Newport Boat Show 2026": different
    // stems, but normalizeName collapses both to "newport boat show" and they
    // share a venue. This used to split into two groups and raise a review flag
    // — the reviewer's job being to merge them by hand. The second grouping key
    // now does it up front, which is the whole point of OPE-473: the flag
    // existed because the grouper missed these.
    const groups = groupEvents([
      mk({ id: "a", name: "Newport Boat Show", slug: "newport-boat-show", vendorLinkCount: 5 }),
      mk({
        id: "b",
        name: "Annual Newport Boat Show",
        slug: "annual-newport-boat-show-2026",
        vendorLinkCount: 3,
        startDate: jan(2027),
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(["a", "b"]);
    // The clean un-suffixed slug wins, per the spec.
    expect(groups[0].canonicalSlug).toBe("newport-boat-show");
    // Vendor-bearing and multi-occurrence — still the roster-fuse risk class,
    // so it still asks for confirmation. Uniting them does not skip that.
    expect(groups[0].needsManualConfirm).toBe(true);
    expect(findVendorNameCollisions(groups)).toEqual([]);
  });

  it("still flags a name collision the venue key cannot resolve — DIFFERENT venue rows", () => {
    // The flag keeps its job for the case OPE-473 deliberately does not touch:
    // one physical place recorded as two venue rows (the Winthrop shape). The
    // name key requires a matching venue_id, so these stay apart — correctly,
    // because merging them is a venue decision, not a series one.
    const groups = groupEvents([
      mk({
        id: "a",
        name: "Newport Boat Show",
        slug: "newport-boat-show",
        venueId: "v1",
        vendorLinkCount: 5,
      }),
      mk({
        id: "b",
        name: "Annual Newport Boat Show",
        slug: "annual-newport-boat-show-2026",
        venueId: "v2",
        vendorLinkCount: 3,
      }),
    ]);

    expect(groups).toHaveLength(2);
    const flags = findVendorNameCollisions(groups);
    expect(flags).toHaveLength(1);
    expect(flags[0].normalizedName).toBe("newport boat show");
    expect(flags[0].groupSlugs).toEqual(["annual-newport-boat-show", "newport-boat-show"]);
  });

  it("reunites the Farmington shape — the specimen this ticket was filed on", () => {
    // Two parents, one edition each, because the hand-created 2027 row carries
    // a state infix: strip the year from `farmington-fair-me-2027` and the stem
    // is `farmington-fair-me`, which is not `farmington-fair`. No user or
    // crawler could traverse from the 2026 edition to the 2027 one.
    //
    // Nothing about the SLUGS changes here — only which series they hang off.
    const groups = groupEvents([
      mk({
        id: "f2026",
        name: "Farmington Fair",
        slug: "farmington-fair",
        venueId: "v-farmington",
        startDate: jan(2026),
      }),
      mk({
        id: "f2027",
        name: "Farmington Fair 2027",
        slug: "farmington-fair-me-2027",
        venueId: "v-farmington",
        startDate: jan(2027),
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(["f2026", "f2027"]);
    expect(groups[0].canonicalSlug).toBe("farmington-fair"); // the clean twin wins
    expect(groups[0].isMultiOccurrence).toBe(true);
    // Different years, so this is a series — not a same-year duplicate.
    expect(groups[0].sameYearConflict).toBe(false);
  });

  it("groups all FOUR Martha's Vineyard editions — OPE-480's specimen", () => {
    // Filed as its own ticket after OPE-432 closed: four editions of one fair
    // carrying TWO series_ids and TWO NULLs, each with a different slug
    // convention. Every one of those conventions is represented below.
    //
    // The stem key alone reaches none of them — `martha-s-vineyard-fair`,
    // `marthas-vineyard-fair-ma`, and `marthas-vineyard-fair` are three
    // distinct stems. The name key collapses all four, because normalizeName
    // strips the trailing year and the apostrophe: every one becomes
    // "marthas vineyard fair", at one shared venue.
    const groups = groupEvents([
      mk({
        id: "mv2026",
        name: "Martha's Vineyard Fair 2026",
        slug: "martha-s-vineyard-fair-2026",
        venueId: "v-mv",
        startDate: jan(2026),
      }),
      mk({
        id: "mv2027",
        name: "Martha's Vineyard Fair 2027",
        slug: "marthas-vineyard-fair-ma-2027",
        venueId: "v-mv",
        startDate: jan(2027),
      }),
      mk({
        id: "mv2028",
        name: "Martha's Vineyard Fair 2028",
        slug: "marthas-vineyard-fair-2028",
        venueId: "v-mv",
        startDate: jan(2028),
      }),
      mk({
        id: "mv2029",
        name: "Martha's Vineyard Fair 2029",
        slug: "marthas-vineyard-fair-2029",
        venueId: "v-mv",
        startDate: jan(2029),
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(["mv2026", "mv2027", "mv2028", "mv2029"]);
    // The clean un-suffixed slug wins, per the EH3 spec.
    expect(groups[0].canonicalSlug).toBe("martha-s-vineyard-fair");
    // Four distinct years — a series, not four same-year duplicates.
    expect(groups[0].sameYearConflict).toBe(false);
  });

  it("does not fuse same-named events that have NO venue", () => {
    // The name key requires a non-null venue. Two events called "Craft Fair"
    // with no venue are not evidence of anything, and fusing them would be the
    // over-grouping the original locked decision was guarding against.
    const groups = groupEvents([
      mk({ id: "a", name: "Craft Fair", slug: "craft-fair-spring-2026", venueId: null }),
      mk({ id: "b", name: "Craft Fair", slug: "craft-fair-autumn-2026", venueId: null }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("does not flag a name collision when neither group carries vendors", () => {
    const groups = groupEvents([
      mk({ id: "a", name: "Spring Fair", slug: "spring-fair", vendorLinkCount: 0 }),
      mk({
        id: "b",
        name: "Annual Spring Fair",
        slug: "annual-spring-fair-2026",
        vendorLinkCount: 0,
      }),
    ]);
    expect(findVendorNameCollisions(groups)).toEqual([]);
  });
});

describe("findCanonicalSlugCollisions — global-uniqueness pre-check", () => {
  it("flags two distinct groups that mint the same canonical_slug (same stem, different venues)", () => {
    // Same stem at two venues → two groups (no fuse), but both fall back to the
    // bare stem for canonicalSlug → a UNIQUE-constraint collision at commit.
    const groups = groupEvents([
      mk({ id: "a", slug: "craft-fair-2026", venueId: "v1" }),
      mk({ id: "b", slug: "craft-fair-2026", venueId: "v2" }),
    ]);
    expect(groups).toHaveLength(2); // confirm they did split into distinct groups

    const collisions = findCanonicalSlugCollisions(groups);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].canonicalSlug).toBe("craft-fair");
    expect(collisions[0].groups).toHaveLength(2);
    expect(collisions[0].groups.map((g) => g.venueId).sort()).toEqual(["v1", "v2"]);
    expect(collisions[0].groups.flatMap((g) => g.memberIds).sort()).toEqual(["a", "b"]);
    expect(collisions[0].groups.every((g) => g.memberCount === 1)).toBe(true);
  });

  it("does not flag when every group's canonical_slug is unique", () => {
    const groups = groupEvents([
      mk({ id: "a", slug: "alpha-fair-2026", venueId: "v1" }),
      mk({ id: "b", slug: "beta-fair-2026", venueId: "v2" }),
    ]);
    expect(findCanonicalSlugCollisions(groups)).toEqual([]);
  });

  it("surfaces collisions through planSeriesBackfill's summary + payload", () => {
    const plan = planSeriesBackfill([
      mk({ id: "a", slug: "craft-fair-2026", venueId: "v1" }),
      mk({ id: "b", slug: "craft-fair-2026", venueId: "v2" }),
      mk({ id: "c", slug: "unique-fest-2026", venueId: "v3" }),
    ]);
    expect(plan.summary.canonicalCollisions).toBe(1);
    expect(plan.canonicalCollisions).toHaveLength(1);
    expect(plan.canonicalCollisions[0].canonicalSlug).toBe("craft-fair");
  });
});

describe("planSeriesBackfill — summary + invariants", () => {
  it("produces correct summary counts over a mixed corpus", () => {
    const plan = planSeriesBackfill([
      // multi-occurrence, vendor-bearing → needsManualConfirm
      mk({ id: "n1", slug: "newport-boat-show-2025", vendorLinkCount: 383, startDate: jan(2025) }),
      mk({ id: "n2", slug: "newport-boat-show-2026", vendorLinkCount: 0, startDate: jan(2026) }),
      // same-year conflict
      mk({ id: "f1", slug: "fryeburg-fair", startDate: jan(2026) }),
      mk({ id: "f2", slug: "fryeburg-fair-2026", startDate: jan(2026) }),
      // a plain singleton
      mk({ id: "s1", slug: "vermont-brewers-festival-2026" }),
    ]);
    expect(plan.summary.totalGroups).toBe(3);
    expect(plan.summary.multiOccurrence).toBe(2);
    expect(plan.summary.singletons).toBe(1);
    expect(plan.summary.needsManualConfirm).toBe(1);
    expect(plan.summary.sameYearConflicts).toBe(1);
    expect(plan.summary.canonicalCollisions).toBe(0); // distinct slugs throughout
  });

  it("is deterministic and does not mutate its input", () => {
    const input = [mk({ id: "b", slug: "b-fair-2026" }), mk({ id: "a", slug: "a-fair-2026" })];
    const snapshot = input.map((e) => e.id);
    const first = bySlug(groupEvents(input));
    const second = bySlug(groupEvents(input));
    expect(first).toEqual(second);
    expect(first).toEqual(["a-fair", "b-fair"]); // sorted by canonicalSlug
    expect(input.map((e) => e.id)).toEqual(snapshot); // input untouched
  });
});
