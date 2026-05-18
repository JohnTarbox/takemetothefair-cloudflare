import { describe, it, expect } from "vitest";
import { makeChecker, type SlugSets } from "../canonical-paths";

function setsFrom(partial: Partial<Record<keyof SlugSets, string[]>> = {}): SlugSets {
  return {
    events: new Set(partial.events ?? []),
    venues: new Set(partial.venues ?? []),
    vendors: new Set(partial.vendors ?? []),
    promoters: new Set(partial.promoters ?? []),
    blog: new Set(partial.blog ?? []),
  };
}

describe("canonical-paths.makeChecker", () => {
  it("returns 'valid' for an entity path whose slug is in the live set", () => {
    const checker = makeChecker(setsFrom({ events: ["wickford-art-festival-2026"] }));
    expect(checker.classifyPath("/events/wickford-art-festival-2026")).toBe("valid");
  });

  it("returns 'stale' for an entity-shaped path whose slug is NOT in the live set", () => {
    const checker = makeChecker(setsFrom({ events: ["wickford-art-festival-2026"] }));
    // These are the 5 examples from the 2026-05-18 recommendations queue pass.
    expect(checker.classifyPath("/events/63rd-wickford-art-festival-2026")).toBe("stale");
    expect(checker.classifyPath("/events/68th-annual-mystic-outdoor-art-festival-2026")).toBe(
      "stale"
    );
    expect(checker.classifyPath("/events/thread-city-hop-fest")).toBe("stale");
    expect(checker.classifyPath("/events/2026-newton-harvest-fair")).toBe("stale");
    expect(
      checker.classifyPath("/events/14th-annual-cape-cod-food-truck-craft-beverage-festival")
    ).toBe("stale");
  });

  it("returns 'unknown-pattern' for state hubs (allowlisted, never filtered)", () => {
    // Critical: state hubs match the /events/{slug} regex shape but must NOT be
    // classified stale just because "maine" isn't in events.slug.
    const checker = makeChecker(setsFrom({ events: [] }));
    expect(checker.classifyPath("/events/maine")).toBe("unknown-pattern");
    expect(checker.classifyPath("/events/massachusetts")).toBe("unknown-pattern");
    expect(checker.classifyPath("/events/new-hampshire")).toBe("unknown-pattern");
  });

  it("returns 'unknown-pattern' for category hubs", () => {
    const checker = makeChecker(setsFrom({ events: [] }));
    expect(checker.classifyPath("/events/fairs")).toBe("unknown-pattern");
    expect(checker.classifyPath("/events/farmers-markets")).toBe("unknown-pattern");
  });

  it("returns 'unknown-pattern' for paths that don't match the entity-path regex", () => {
    const checker = makeChecker(setsFrom());
    expect(checker.classifyPath("/")).toBe("unknown-pattern");
    expect(checker.classifyPath("/about")).toBe("unknown-pattern");
    expect(checker.classifyPath("/blog/category/foo")).toBe("unknown-pattern"); // 3 segments
    expect(checker.classifyPath("/events")).toBe("unknown-pattern"); // bare index
  });

  it("handles each entity type independently", () => {
    const checker = makeChecker(
      setsFrom({
        events: ["evt-a"],
        venues: ["ven-b"],
        vendors: ["vnd-c"],
        promoters: ["pmt-d"],
        blog: ["post-e"],
      })
    );
    expect(checker.classifyPath("/events/evt-a")).toBe("valid");
    expect(checker.classifyPath("/venues/ven-b")).toBe("valid");
    expect(checker.classifyPath("/vendors/vnd-c")).toBe("valid");
    expect(checker.classifyPath("/promoters/pmt-d")).toBe("valid");
    expect(checker.classifyPath("/blog/post-e")).toBe("valid");

    // Wrong table for the slug → stale (the slug literally is not in the
    // table we look up against).
    expect(checker.classifyPath("/venues/evt-a")).toBe("stale");
  });

  it("strips trailing slash before classification", () => {
    const checker = makeChecker(setsFrom({ events: ["spring-show"] }));
    expect(checker.classifyPath("/events/spring-show/")).toBe("valid");
  });
});
