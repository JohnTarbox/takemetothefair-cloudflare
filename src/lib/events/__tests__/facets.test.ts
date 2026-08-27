/**
 * OPE-395 — the facet registry.
 *
 * These tests are mostly about the ways a facet mesh fails SILENTLY. A shadowed
 * slug, a town filed under two regions, or a state whose nav links to routes
 * that do not exist all render perfectly well and are only visible as a slow
 * leak in Search Console weeks later.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveFacet,
  monthWindow,
  weekendWindow,
  allFacetSlugs,
  facetSlugsByKind,
  isFacetIndexable,
  stateHasFacets,
  FACET_STATES,
  FACET_MIN_EVENTS,
  WEEKEND_MIN_EVENTS,
  TYPE_FACETS,
} from "@/lib/events/facets";
import { STATE_REGIONS } from "@/lib/events/facet-regions";

const NOW = new Date(Date.UTC(2026, 7, 16)); // Sunday 16 August 2026

describe("facet slug registry", () => {
  it("has no slug collisions within a state", () => {
    // resolveFacet matches month → weekend → type → region, first hit wins. A
    // region called "august" would therefore be unreachable — the page would
    // exist, be linked, and quietly serve the month instead.
    for (const state of FACET_STATES) {
      const slugs = allFacetSlugs(state);
      expect(new Set(slugs).size, `duplicate facet slug in ${state}`).toBe(slugs.length);
    }
  });

  it("resolves every declared slug to the kind that declared it", () => {
    for (const state of FACET_STATES) {
      const byKind = facetSlugsByKind(state);
      for (const [kind, slugs] of Object.entries(byKind)) {
        for (const slug of slugs) {
          const facet = resolveFacet(state, slug, NOW);
          expect(facet, `${state}/${slug} did not resolve`).not.toBeNull();
          expect(facet!.kind, `${state}/${slug} resolved as the wrong kind`).toBe(kind);
        }
      }
    }
  });

  it("returns null for an unknown segment rather than an empty listing", () => {
    // A soft-404 rendering a plausible page is worse than a 404: it gets
    // indexed, and every typo becomes a competing URL.
    expect(resolveFacet("massachusetts", "asdf", NOW)).toBeNull();
    expect(resolveFacet("massachusetts", "", NOW)).toBeNull();
    // A CT region must not resolve on the MA path.
    expect(resolveFacet("massachusetts", "quiet-corner", NOW)).toBeNull();
    expect(resolveFacet("connecticut", "berkshires", NOW)).toBeNull();
  });

  it("gives states without a region map no region facets, not an error", () => {
    // OPE-586 moved Maine INTO the mesh, so this now uses a state that is still
    // deliberately out of it. NH/VT/RI are Phase 2, gated on the 2026-09-17
    // MA/CT KPI read.
    expect(resolveFacet("new-hampshire", "berkshires", NOW)).toBeNull();
    expect(facetSlugsByKind("new-hampshire").region).toEqual([]);
    // Months and types are still defined for every state — which is exactly why
    // the nav has to be gated on stateHasFacets rather than on this list.
    expect(facetSlugsByKind("new-hampshire").month).toHaveLength(12);
  });

  it("keeps NH/VT/RI out of the mesh — the Phase-2 gate, asserted", () => {
    // ⚠️ Shipping a region map for these before the KPI read would quietly
    // expand the experiment past the cohort it is being measured on, and the
    // read would then be uninterpretable. Failing here is the point.
    for (const state of ["new-hampshire", "vermont", "rhode-island"]) {
      expect(facetSlugsByKind(state).region, `${state} must stay Phase 2`).toEqual([]);
    }
  });

  it("Maine is in the mesh with regions that match its inventory", () => {
    const regions = facetSlugsByKind("maine").region;
    expect(regions).toContain("bangor-penobscot"); // 36 upcoming — the OPE-415 gap
    expect(regions).toContain("kennebec-valley"); // augusta 15
    expect(regions.length).toBeGreaterThanOrEqual(8);
  });
});

describe("FACET_STATES matches the routes on disk", () => {
  // The nav and the sitemap are both driven by FACET_STATES. If it names a
  // state with no `[facet]` route, every nav link for that state 404s — the
  // most damaging thing this feature could ship.
  it("has a [facet]/page.tsx for each listed state, and no unlisted ones", () => {
    const eventsDir = path.join(process.cwd(), "src/app/events");
    const withFacetRoute = fs
      .readdirSync(eventsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => fs.existsSync(path.join(eventsDir, d.name, "[facet]", "page.tsx")))
      .map((d) => d.name)
      .sort();
    expect(withFacetRoute).toEqual([...FACET_STATES].sort());
  });

  it("stateHasFacets agrees with the list", () => {
    expect(stateHasFacets("massachusetts")).toBe(true);
    expect(stateHasFacets("connecticut")).toBe(true);
    expect(stateHasFacets("maine")).toBe(true); // OPE-586 Phase 1
    // Phase 2 — must stay false until the 2026-09-17 KPI read.
    expect(stateHasFacets("new-hampshire")).toBe(false);
    expect(stateHasFacets("vermont")).toBe(false);
    expect(stateHasFacets("rhode-island")).toBe(false);
  });
});

describe("region maps", () => {
  it("never files one town under two regions of the same state", () => {
    // Double-counting would make the region pages sum to more than the state,
    // and put the same fair on two competing pages.
    for (const [state, regions] of Object.entries(STATE_REGIONS)) {
      const seen = new Map<string, string>();
      for (const [slug, def] of Object.entries(regions)) {
        for (const city of def.cities) {
          const prior = seen.get(city);
          expect(prior, `${state}: "${city}" is in both ${prior} and ${slug}`).toBeUndefined();
          seen.set(city, slug);
        }
      }
    }
  });

  it("keeps each region under D1's bound-parameter ceiling", () => {
    // The region predicate binds one parameter per town and D1 caps a statement
    // at 100. A runaway list would throw at query time, not degrade.
    for (const [state, regions] of Object.entries(STATE_REGIONS)) {
      for (const [slug, def] of Object.entries(regions)) {
        expect(def.cities.length, `${state}/${slug} is too large`).toBeLessThanOrEqual(70);
        expect(def.cities.length).toBeGreaterThan(0);
      }
    }
  });

  it("stores every town lowercased and trimmed, because that is how it is matched", () => {
    // The predicate compares against `lower(trim(venues.city))`. A stray capital
    // here matches nothing, and matches nothing SILENTLY.
    for (const regions of Object.values(STATE_REGIONS)) {
      for (const def of Object.values(regions)) {
        for (const city of def.cities) {
          expect(city).toBe(city.toLowerCase().trim());
          expect(city.length).toBeGreaterThan(1);
        }
      }
    }
  });
});

describe("monthWindow", () => {
  it("resolves a bare month to its NEXT occurrence", () => {
    // Yearless URLs accrue authority; a dated one throws its ranking away every
    // January. So "march" seen in August 2026 means March 2027.
    const march = monthWindow(2, NOW);
    expect(march.start.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(march.end.toISOString()).toBe("2027-04-01T00:00:00.000Z");
  });

  it("treats the current month as the current year, not next", () => {
    const august = monthWindow(7, NOW);
    expect(august.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(august.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls December into January of the following year", () => {
    const dec = monthWindow(11, new Date(Date.UTC(2026, 11, 20)));
    expect(dec.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(dec.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("weekendWindow", () => {
  it("always spans Friday 00:00 to Monday 00:00", () => {
    // Every day of one week — the window must be the same three days from
    // Monday's perspective and from Sunday's.
    for (let day = 10; day <= 16; day++) {
      const w = weekendWindow(new Date(Date.UTC(2026, 7, day, 13)));
      expect(w.start.getUTCDay(), `day ${day} start`).toBe(5); // Friday
      expect(w.end.getTime() - w.start.getTime()).toBe(3 * 86_400_000);
    }
  });

  it("shows a Sunday visitor the weekend they are IN, not the next one", () => {
    // Sunday 16 Aug 2026 → the weekend that began Friday 14 Aug.
    const w = weekendWindow(NOW);
    expect(w.start.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("shows a Monday visitor the COMING weekend", () => {
    const w = weekendWindow(new Date(Date.UTC(2026, 7, 17, 9))); // Monday
    expect(w.start.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });
});

describe("indexability floor", () => {
  it("holds month and region pages to the standard floor", () => {
    const march = resolveFacet("massachusetts", "march", NOW)!;
    expect(isFacetIndexable(march, FACET_MIN_EVENTS - 1)).toBe(false);
    expect(isFacetIndexable(march, FACET_MIN_EVENTS)).toBe(true);
  });

  it("holds this-weekend to a LOWER floor, because thin means something else there", () => {
    // A March page with four events is unfinished — March will have forty once
    // organisers publish. A this-weekend page with four events is complete:
    // four IS everything on this weekend, and the reader is fully answered.
    const weekend = resolveFacet("massachusetts", "this-weekend", NOW)!;
    expect(WEEKEND_MIN_EVENTS).toBeLessThan(FACET_MIN_EVENTS);
    expect(isFacetIndexable(weekend, WEEKEND_MIN_EVENTS)).toBe(true);
    expect(isFacetIndexable(weekend, WEEKEND_MIN_EVENTS - 1)).toBe(false);
  });

  it("never marks an empty facet indexable", () => {
    for (const state of FACET_STATES) {
      for (const slug of allFacetSlugs(state)) {
        expect(isFacetIndexable(resolveFacet(state, slug, NOW)!, 0)).toBe(false);
      }
    }
  });
});

describe("type facets", () => {
  it("names an exact category token, not a substring", () => {
    // Substring matching would fold "Craft Fair" and "Agricultural Fair" into
    // the generic "Fairs" page and make three facets near-duplicates — the
    // fastest way to get a mesh devalued.
    expect(TYPE_FACETS["fairs"].category).toBe("Fair");
    expect(TYPE_FACETS["craft-fairs"].category).toBe("Craft Fair");
    expect(TYPE_FACETS["agricultural-fairs"].category).toBe("Agricultural Fair");
    const tokens = Object.values(TYPE_FACETS).map((t) => t.category);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("launch scale", () => {
  it("declares enough facets per state to meet the ≥20 acceptance", () => {
    // Acceptance is ≥20 INDEXABLE pages per state; that depends on live counts.
    // What is assertable here is that enough are declared for it to be
    // reachable at all.
    for (const state of FACET_STATES) {
      expect(allFacetSlugs(state).length, state).toBeGreaterThanOrEqual(20);
    }
  });
});
