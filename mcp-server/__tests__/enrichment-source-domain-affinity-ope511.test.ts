/**
 * OPE-511 — auto-merge precondition #2: whose website is this, actually?
 *
 * The approved auto-merge rule is `confidence >= 0.90 AND flags = 0 AND prior =
 * NULL`, and the clearest wrong class it admits is cross-vendor attribution.
 * The specimen, live in the pending queue: `Third Shift Fabrication` proposed
 * `(603) 899-2465`, scraped from `udderlygutters.com` — Udderly Gutters' site —
 * at confidence 0.90 with zero flags. Fully eligible, and wrong.
 *
 * ⚠️ THE TICKET'S OWN RULE (a) DOES NOT CATCH IT.
 *
 * "Reject when source_url's domain differs from the vendor's own website
 * domain" passes this specimen unchanged, because `Third Shift Fabrication`'s
 * STORED website IS `https://udderlygutters.com`. Two vendor rows carry the
 * same URL and the enricher fetched exactly what it was told. `vendor.website`
 * is the contaminated field, so it cannot also be the authority. Measured on
 * prod: 564 vendors — 22% of the 2,589 with a site — share 180 domains.
 *
 * What is left is the NAME, which no scraper wrote. Values below are real prod
 * rows, per the OPE-504 red-first discipline.
 */
import { describe, it, expect } from "vitest";
import { domainLabel, sourceDomainRelatesToVendor } from "../src/enrichment/safety-rules.js";

describe("domainLabel", () => {
  it("takes the registrable label", () => {
    expect(domainLabel("https://www.starsandlighthouses.com/")).toBe("starsandlighthouses");
    expect(domainLabel("http://www.weirsbeach.com/")).toBe("weirsbeach");
    expect(domainLabel("https://koa.com/campgrounds/chocorua/")).toBe("koa");
  });

  it("takes the SUBDOMAIN on a site-builder host, where the business actually is", () => {
    // Found by running this guard over the live pending set before shipping it:
    // two of its twelve holds were `squarespace`, and both were my label
    // extraction's fault rather than the data's.
    expect(domainLabel("https://laikenmaehandmade.squarespace.com/")).toBe("laikenmaehandmade");
    expect(domainLabel("https://kaybakes4u.squarespace.com/")).toBe("kaybakes4u");
    expect(domainLabel("https://someshop.myshopify.com")).toBe("someshop");
  });

  it("returns null for something unparseable rather than guessing", () => {
    expect(domainLabel("not a url")).toBeNull();
  });
});

describe("sourceDomainRelatesToVendor — the four live specimens must all be held", () => {
  const specimens: Array<[string, string]> = [
    ["Third Shift Fabrication", "https://udderlygutters.com"],
    ["Half Moon Enterprises", "http://www.weirsbeach.com/"],
    ["Mill Cove Video Production", "https://www.starsandlighthouses.com/"],
    ["acrylic painting", "https://lsebastudio.com"],
  ];

  for (const [name, url] of specimens) {
    it(`holds ${name} → ${domainLabel(url)}`, () => {
      expect(sourceDomainRelatesToVendor(name, url)).toBe(false);
    });
  }

  it("passes Udderly Gutters on the SAME url — the pair is the whole point", () => {
    // Two vendors, one website. Any rule keyed on `vendor.website` treats these
    // identically; only the name tells them apart.
    expect(sourceDomainRelatesToVendor("Udderly Gutters", "https://udderlygutters.com")).toBe(true);
    expect(
      sourceDomainRelatesToVendor("Third Shift Fabrication", "https://udderlygutters.com")
    ).toBe(false);
  });
});

describe("positive controls — real vendors whose domain is not their name", () => {
  // The acceptance asks for these explicitly. All are live pending rows, and a
  // guard that held them would be sending honest work to a queue with no drain.
  const legitimate: Array<[string, string]> = [
    ["Lynne Puhalla", "http://puhallastudios.com/"], // surname
    ["Allen Studios", "https://www.nancyallenarts.com/"], // surname inside a longer domain
    ["Fidium", "http://www.fidiumfiber.com"], // name is a PREFIX of the domain
    ["Innerglass Window Systems", "https://stormwindows.com/"], // shares "windows"
    ["GT Donaghue Roofing", "https://www.donaghueconstruction.com/"], // shares "donaghue"
    ["Chocorua Camping Village KOA", "https://koa.com/campgrounds/chocorua/"], // short token
    ["Shelf Genie of Massachusetts", "https://www.shelfgenie.com/locations/massachusetts/"],
    [
      "Couzens, Domingos, Allen & Associates - Ameriprise Financial",
      "https://www.ameripriseadvisors.com/gary.helbling/",
    ],
    ["Ye Olde Pepper Candy Companie, LTD", "https://www.oldepeppercandy.com/"],
    ["Brewers Yacht Sales", "https://breweryacht.com"],
  ];

  for (const [name, url] of legitimate) {
    it(`passes ${name}`, () => {
      expect(sourceDomainRelatesToVendor(name, url)).toBe(true);
    });
  }
});

describe("it declines to accuse when it has nothing to go on", () => {
  it("passes an unparseable source url", () => {
    expect(sourceDomainRelatesToVendor("Anything", "not a url")).toBe(true);
  });

  it("passes when the business name is entirely generic words", () => {
    // "The Company LLC" yields no comparable token. Holding on that would be
    // punishing a bad NAME, which is a different defect (and a different queue).
    expect(sourceDomainRelatesToVendor("The Company LLC", "https://example.com")).toBe(true);
  });
});

/**
 * Measured on the full live eligible set (177 candidates: pending, confidence
 * >= 0.90, flags empty, no prior value) on 2026-08-23:
 *
 *   HELD 10 of 177 — 5.6%
 *
 *   the 4 specimens above, plus 6 acronym/descriptive domains:
 *   Premier -> pontoons · East Coast Yacht Sales -> ecys ·
 *   Alternative Marine Propulsion Services -> ampsusa ·
 *   Steve Schuyler Bookseller -> rarebookstore ·
 *   Pulling It All Together -> nhpiat · Dragon's Breath Pottery -> dbpots
 *
 * Those six are why this flag is a HOLD and not a discard: each is plausibly
 * the vendor's real site, and each is also exactly the shape a misattribution
 * takes. A human deciding once is the correct cost; throwing the value away is
 * not.
 */
