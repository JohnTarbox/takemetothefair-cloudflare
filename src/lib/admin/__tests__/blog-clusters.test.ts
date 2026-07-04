/**
 * OPE-96 — the blog cluster classifier is a pure, precedence-ordered slug/tag
 * map (`CLUSTER_RULES`). These tests pin the design brief's worked examples
 * (gun-shows → Gun shows, *-breweries-* → Breweries & beer, the-big-e → The
 * Big E) plus the precedence rules that matter (proper-noun / topical buckets
 * must win before the broad "fair"/"guide" catch-alls) and the "Other /
 * general" default.
 */
import { describe, expect, it } from "vitest";
import { classifyCluster, DEFAULT_CLUSTER } from "../blog-clusters";

const bySlug = (slug: string) => classifyCluster({ slug, tags: [] });

describe("classifyCluster — design-brief worked examples", () => {
  it("maps gun-show slugs to Gun shows", () => {
    expect(bySlug("gun-shows-in-new-england")).toBe("Gun shows");
    expect(bySlug("nh-gun-show-guide")).toBe("Gun shows");
  });

  it("maps brewery slugs to Breweries & beer", () => {
    expect(bySlug("maine-breweries-guide")).toBe("Breweries & beer");
    expect(bySlug("vermont-craft-beer-trail")).toBe("Breweries & beer");
  });

  it("maps the-big-e to The Big E (before generic fair matching)", () => {
    expect(bySlug("the-big-e")).toBe("The Big E");
    expect(bySlug("the-big-e-2026-guide")).toBe("The Big E");
  });
});

describe("classifyCluster — precedence (most-specific first)", () => {
  it("craft-fairs beat the broad state-fair bucket", () => {
    expect(bySlug("holiday-craft-fairs-maine")).toBe("Craft fairs");
  });

  it("generic state/agricultural fair guides land in State fair/festival guides", () => {
    expect(bySlug("fryeburg-fair-guide")).toBe("State fair/festival guides");
    expect(bySlug("county-fair-season")).toBe("State fair/festival guides");
  });

  it("classifies the remaining topical buckets", () => {
    expect(bySlug("portland-scottish-highland-games")).toBe("Scottish & Highland");
    expect(bySlug("maine-made-program-explained")).toBe("Maine Made program");
    expect(bySlug("king-richards-renaissance-faire")).toBe("Renaissance faires");
    expect(bySlug("maine-boat-show")).toBe("Boat & marine");
    expect(bySlug("annual-clam-festival")).toBe("Food festivals");
    expect(bySlug("how-to-sell-at-a-craft-fair")).toBe("Craft fairs");
  });

  it("matches on tags when the slug is unrevealing", () => {
    expect(classifyCluster({ slug: "summer-roundup", tags: ["Gun Show"] })).toBe("Gun shows");
    expect(classifyCluster({ slug: "summer-roundup", tags: ["beer"] })).toBe("Breweries & beer");
  });
});

describe("classifyCluster — default", () => {
  it("falls through to Other / general", () => {
    expect(bySlug("welcome-to-the-blog")).toBe(DEFAULT_CLUSTER);
    expect(classifyCluster({ slug: "random-post", tags: [] })).toBe("Other / general");
  });
});
