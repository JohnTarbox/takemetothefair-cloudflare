/**
 * OPE-858 — the promoter duplicate advisory, pinned against REAL production
 * pairs on both sides.
 *
 * ## ⚠️ Amendment H, and why the false-positive block is half this file
 *
 * The ticket measured that a naive rule returns **more false positives than
 * true positives**. So "it finds the Craftah duplicate" is not the interesting
 * property — a matcher that returns every promoter for every input satisfies
 * every true-positive assertion here and would be actively harmful.
 *
 * Each named false positive below is a real pair from the 748-row production
 * table, and each is the specific thing one axis would fuse if its guard were
 * dropped. They are not padding; they are the acceptance.
 */
import { describe, it, expect } from "vitest";
import {
  findPromoterDuplicates,
  normalizePromoterRoot,
  websiteRegistrableDomain,
  isPlatformDomain,
} from "@takemetothefair/utils";

type Row = Parameters<typeof findPromoterDuplicates>[1][number];
const row = (o: Partial<Row> & { id: string }): Row => ({
  slug: o.id,
  companyName: null,
  website: null,
  state: null,
  ...o,
});

describe("websiteRegistrableDomain", () => {
  it("collapses subdomains — the Craftah case", () => {
    // The design driver: www.craftah.com and events.craftah.com are one
    // company, and a full-host comparison misses it entirely.
    expect(websiteRegistrableDomain("https://www.craftah.com")).toBe("craftah.com");
    expect(websiteRegistrableDomain("https://events.craftah.com/apply")).toBe("craftah.com");
  });

  it("accepts a bare host — promoters.website holds both forms", () => {
    expect(websiteRegistrableDomain("craftah.com")).toBe("craftah.com");
  });

  it("returns null for junk rather than a bogus match", () => {
    for (const junk of ["", "   ", "not a url", "localhost", null, undefined]) {
      expect(websiteRegistrableDomain(junk)).toBeNull();
    }
  });
});

describe("normalizePromoterRoot", () => {
  it("Craftah LLC and Craftah, LLC share a root — one comma apart in prod", () => {
    expect(normalizePromoterRoot("Craftah LLC")).toBe("craftah");
    expect(normalizePromoterRoot("Craftah, LLC")).toBe("craftah");
  });

  it("strips a trailing form word, not a leading one", () => {
    expect(normalizePromoterRoot("North Stonington Agricultural Fair Inc")).toBe(
      normalizePromoterRoot("North Stonington Agricultural Fair Association")
    );
    // "Event" carries identity at the front and none at the back.
    expect(normalizePromoterRoot("Event Group of Maine")).toContain("event");
  });

  it("drops a leading 'the'", () => {
    expect(normalizePromoterRoot("The Guilford Fair")).toBe(normalizePromoterRoot("Guilford Fair"));
  });

  it("never reduces a name to nothing", () => {
    expect(normalizePromoterRoot("LLC")).not.toBe("");
  });
});

describe("OPE-858 — TRUE positives", () => {
  it("Craftah: matches on BOTH axes and reports both", () => {
    const hits = findPromoterDuplicates(
      { name: "Craftah, LLC", website: "https://events.craftah.com", state: "ME" },
      [
        row({
          id: "p1",
          companyName: "Craftah LLC",
          website: "https://www.craftah.com",
          state: "ME",
        }),
      ]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].matched_on.sort()).toEqual(["name_root_and_state", "registrable_domain"]);
  });

  it("North Stonington: domain axis catches what the name axis cannot", () => {
    // "Agricultural Fair Inc" vs "Agricultural Fair Association" normalize the
    // same, but the states could differ in principle; the domain is the robust
    // signal here.
    const hits = findPromoterDuplicates(
      { name: "North Stonington Agricultural Fair Association", website: "nostoningtonfair.org" },
      [
        row({
          id: "p1",
          companyName: "North Stonington Agricultural Fair Inc",
          website: "https://www.nostoningtonfair.org",
        }),
      ]
    );
    expect(hits.map((h) => h.matched_on)).toEqual([["registrable_domain"]]);
  });

  it("name axis fires ALONE when neither row has a website", () => {
    // 135 of 748 promoters (18%) have no website, so axis 2 has to work with
    // no domain evidence at all. Landmark: both sides are website-less, so a
    // hit here can only have come from axis 2.
    const hits = findPromoterDuplicates({ name: "Craftah, LLC", website: null, state: "ME" }, [
      row({ id: "p1", companyName: "Craftah LLC", website: null, state: "ME" }),
    ]);
    expect(hits.map((h) => h.matched_on)).toEqual([["name_root_and_state"]]);
  });

  it("⚠️ Guilford is a DOMAIN-axis case, not a name-axis one", () => {
    // I first wrote this as a name-axis test and it failed — correctly. The
    // ticket says so itself: the domain axis finds Guilford because the "name
    // roots differ too much". `Guilford Agricultural Society` reduces to
    // "guilford agricultural" and `The Guilford Fair` to "guilford fair".
    // Recording it as an assertion so nobody re-adds the wrong expectation.
    expect(normalizePromoterRoot("Guilford Agricultural Society")).not.toBe(
      normalizePromoterRoot("The Guilford Fair")
    );
    const byName = findPromoterDuplicates(
      { name: "Guilford Agricultural Society", website: null, state: "CT" },
      [row({ id: "p1", companyName: "The Guilford Fair", website: null, state: "CT" })]
    );
    expect(byName).toEqual([]);

    const byDomain = findPromoterDuplicates(
      { name: "Guilford Agricultural Society", website: "https://guilfordfair.org", state: "CT" },
      [
        row({
          id: "p1",
          companyName: "The Guilford Fair",
          website: "www.guilfordfair.org",
          state: "CT",
        }),
      ]
    );
    expect(byDomain.map((h) => h.matched_on)).toEqual([["registrable_domain"]]);
  });
});

describe("OPE-858 — FALSE positives that must return ZERO", () => {
  it("facebook.com — 4 unrelated organisations", () => {
    const fb = "https://facebook.com/somepage";
    const hits = findPromoterDuplicates({ name: "Rustic Elegance", website: fb, state: "ME" }, [
      row({ id: "p1", companyName: "Smith's U-Pick Blueberries", website: fb, state: "ME" }),
      row({ id: "p2", companyName: "Greenfield Hill Grange No. 133", website: fb, state: "CT" }),
      row({ id: "p3", companyName: "Milford Porchfest East Shore", website: fb, state: "CT" }),
    ]);
    // Landmark: the domain really is shared and really is usable-looking.
    expect(websiteRegistrableDomain(fb)).toBe("facebook.com");
    expect(isPlatformDomain("facebook.com")).toBe(true);
    expect(hits).toEqual([]);
  });

  it("e-clubhouse.org — two genuinely different Lions clubs", () => {
    const host = "https://e-clubhouse.org/sites/niantic";
    const hits = findPromoterDuplicates(
      { name: "Niantic Lions Club", website: host, state: "CT" },
      [
        row({
          id: "p1",
          companyName: "Waterville Lions Club",
          website: "https://e-clubhouse.org/sites/waterville",
          state: "ME",
        }),
      ]
    );
    expect(hits).toEqual([]);
  });

  it("Washington County Fair ME vs Association RI — same root, different state", () => {
    // The case the `+ state` requirement exists for. Drop it and these fuse.
    const a = "Washington County Fair";
    const b = "Washington County Fair Association";
    expect(normalizePromoterRoot(a)).toBe(normalizePromoterRoot(b)); // landmark: roots DO match
    const hits = findPromoterDuplicates({ name: b, website: null, state: "RI" }, [
      row({ id: "p1", companyName: a, website: null, state: "ME" }),
    ]);
    expect(hits).toEqual([]);
  });

  it("OPE-822's own pair is NOT caught — the stated benefit cap, as a test", () => {
    // Different registrable domains AND different states. Asserting this keeps
    // the honest limit from quietly becoming a claim of general coverage.
    const hits = findPromoterDuplicates(
      { name: "New England Home Shows", website: "https://newenglandhomeshows.com", state: "MA" },
      [
        row({
          id: "p1",
          companyName: "New England Home Show",
          website: "https://nehomeshow.com",
          state: "RI",
        }),
      ]
    );
    expect(hits).toEqual([]);
  });

  it("a missing state on either side is not agreement", () => {
    // Absence of evidence must not read as evidence of sameness.
    const hits = findPromoterDuplicates({ name: "Craftah LLC", website: null, state: null }, [
      row({ id: "p1", companyName: "Craftah, LLC", website: null, state: "ME" }),
    ]);
    expect(hits).toEqual([]);
  });

  it("two promoters with no website and no state never match on domain", () => {
    // 135 of 748 promoters (18%) have no website — the domain axis is
    // structurally blind to them, and must not invent a match from two nulls.
    const hits = findPromoterDuplicates({ name: "Alpha Fair", website: null, state: "ME" }, [
      row({ id: "p1", companyName: "Beta Fair", website: null, state: "ME" }),
    ]);
    expect(hits).toEqual([]);
  });
});

describe("OPE-858 — the advisory is not a gate", () => {
  it("returns an array and never a refusal signal", () => {
    // There is no confidence score and no threshold, so there is nothing to
    // tune into a block. suggest_event's blocking guard produced the routine
    // force_create problem (OPE-454 / OPE-650); this has nothing to override.
    const hits = findPromoterDuplicates(
      { name: "Craftah, LLC", website: "events.craftah.com", state: "ME" },
      [row({ id: "p1", companyName: "Craftah LLC", website: "www.craftah.com", state: "ME" })]
    );
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0]).not.toHaveProperty("blocked");
    expect(hits[0]).not.toHaveProperty("confidence");
  });

  it("an empty table yields no candidates and does not throw", () => {
    expect(findPromoterDuplicates({ name: "Anything", website: "x.com", state: "ME" }, [])).toEqual(
      []
    );
  });
});
