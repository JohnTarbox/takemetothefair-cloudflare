/**
 * OPE-837 — discovery, classification, roster and price extraction.
 *
 * The specimen assertions run against `fixtures/ope837-mainecheesefestival.json`,
 * a REAL capture of the site named in the ticket (fetched 2026-09-07), not a
 * fixture written to suit the parser. That matters: every earlier attempt in
 * this repo to test an extractor against hand-made input passed while the
 * extractor was wrong about the page it was written for.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFromHint,
  classifyPage,
  selectCrawlTargets,
  selectTicketVendorLink,
  registrableDomain,
  isSameSite,
  isTicketVendorHost,
  normalizeUrlForDedup,
  type DiscoveredLink,
} from "../page-crawl";
import { extractInlineRoster, splitRosterRun } from "../inline-roster";
import { parseAdmissionPrices } from "../admission-price";
import fixture from "./fixtures/ope837-mainecheesefestival.json";

const HOME = fixture.homeUrl;
const anchors = fixture.homeAnchors as DiscoveredLink[];

describe("registrableDomain / isSameSite", () => {
  it("reduces a subdomain to its registrable domain", () => {
    expect(registrableDomain("www.mainecheesefestival.org")).toBe("mainecheesefestival.org");
    expect(registrableDomain("mainecheesefestival.org")).toBe("mainecheesefestival.org");
  });

  it("keeps three labels for a known multi-label public suffix", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("treats the festivalpro ticket host as a DIFFERENT site", () => {
    // This is the fact that forces the one-hop exception to exist. If this
    // ever flips to true, `selectTicketVendorLink` is dead code.
    expect(isSameSite("https://mainecheesefestival.festivalpro.com/form/X/0", HOME)).toBe(false);
  });

  it("treats a same-site nav page as same site", () => {
    expect(isSameSite(`${HOME}?page_id=21`, HOME)).toBe(true);
  });
});

describe("classifyFromHint — the WordPress ?page_id case", () => {
  // The whole reason anchor text is tried before the slug.
  it("classifies from anchor text when the URL carries no slug signal", () => {
    const cases: Array<[string, string, string]> = [
      ["Tickets", "?page_id=54", "tickets"],
      ["Artisan Vendors", "?page_id=21", "vendors"],
      ["Cheesemakers", "?page_id=57", "vendors"],
      ["Food Trucks", "?page_id=61", "vendors"],
      ["Programming", "?page_id=806", "schedule"],
      ["Sponsors", "?page_id=30", "sponsors"],
      ["FAQs", "?page_id=789", "faq"],
    ];
    for (const [text, path, expected] of cases) {
      const got = classifyFromHint({ url: `${HOME}${path}`, text });
      expect(`${text}=${got.cls}`).toBe(`${text}=${expected}`);
      expect(got.matchedOn).toBe("anchor-text");
    }
  });

  it("falls back to the URL slug when anchor text is empty", () => {
    const got = classifyFromHint({ url: "https://x.org/our-vendors", text: "" });
    expect(got.cls).toBe("vendors");
    expect(got.matchedOn).toBe("url-slug");
  });

  it("does not mistake an entertainment lineup for a vendor page, or vice versa", () => {
    expect(classifyFromHint({ url: "https://x.org/a", text: "Music Lineup" }).cls).toBe("schedule");
    expect(classifyFromHint({ url: "https://x.org/a", text: "Vendor Lineup" }).cls).toBe("vendors");
  });

  it("returns other for nav that carries no event fields", () => {
    for (const t of ["Home", "About Us", "Contact", "Volunteers", "Directions"]) {
      expect(classifyFromHint({ url: "https://x.org/a", text: t }).cls).toBe("other");
    }
  });
});

describe("classifyPage — post-fetch heading upgrade", () => {
  it("upgrades an unclassified hint using the page heading", () => {
    expect(classifyPage({ hintClass: "other", heading: "2026 Artisan Vendors" })).toBe("vendors");
  });

  it("lets a definite heading override a wrong hint", () => {
    expect(classifyPage({ hintClass: "faq", heading: "Tickets" })).toBe("tickets");
  });

  it("keeps the hint when the heading says nothing", () => {
    expect(classifyPage({ hintClass: "vendors", heading: "Welcome" })).toBe("vendors");
  });
});

describe("selectCrawlTargets — against the real nav", () => {
  const targets = selectCrawlTargets(anchors, HOME);

  it("finds all four pages the ticket names, from the real homepage", () => {
    const urls = targets.map((t) => t.url);
    for (const id of ["54", "21", "57", "61"]) {
      expect(urls.some((u) => u.includes(`page_id=${id}`))).toBe(true);
    }
    // Acceptance asks for >= 3 of the 4. Positive landmark: state how many
    // candidates were examined, so a matcher that silently stops matching
    // cannot report a clean pass.
    expect(anchors.length).toBeGreaterThan(10);
  });

  it("puts the ticket page first, because the cap is spent in priority order", () => {
    expect(targets[0].hintClass).toBe("tickets");
  });

  it("never leaves the site and never exceeds the cap", () => {
    expect(targets.length).toBeLessThanOrEqual(15);
    for (const t of targets) expect(isSameSite(t.url, HOME)).toBe(true);
  });

  it("excludes the page we already fetched", () => {
    const urls = selectCrawlTargets(anchors, HOME).map((t) => normalizeUrlForDedup(t.url));
    expect(urls).not.toContain(normalizeUrlForDedup(HOME));
  });

  it("skips a URL already fetched from the email itself", () => {
    const out = selectCrawlTargets(anchors, HOME, { alreadyFetched: [`${HOME}?page_id=54`] });
    expect(out.some((t) => t.url.includes("page_id=54"))).toBe(false);
  });

  // The acceptance criterion "a single-page site with no nav produces exactly
  // today's behaviour and no extra fetches".
  it("returns zero targets for a site whose nav carries no event fields", () => {
    const plain: DiscoveredLink[] = [
      { url: "https://plain.org/", text: "Home" },
      { url: "https://plain.org/about", text: "About Us" },
      { url: "https://plain.org/contact", text: "Contact" },
    ];
    expect(selectCrawlTargets(plain, "https://plain.org/")).toEqual([]);
  });

  it("refuses media files and admin/cart paths", () => {
    const junk: DiscoveredLink[] = [
      { url: "https://x.org/vendor-map.pdf", text: "Vendor Map" },
      { url: "https://x.org/cart", text: "Tickets in cart" },
      { url: "https://x.org/wp-admin/edit.php", text: "Vendors" },
    ];
    expect(selectCrawlTargets(junk, "https://x.org/")).toEqual([]);
  });

  it("respects an explicit cap", () => {
    expect(selectCrawlTargets(anchors, HOME, { cap: 2 })).toHaveLength(2);
  });
});

describe("selectTicketVendorLink — the single off-site hop", () => {
  it("finds the festivalpro form linked from the real Tickets page", () => {
    const ticketAnchors = fixture.pages.tickets_54.anchors as DiscoveredLink[];
    const hop = selectTicketVendorLink(ticketAnchors, fixture.pages.tickets_54.url);
    expect(hop).not.toBeNull();
    expect(hop!.url).toContain("festivalpro.com");
  });

  it("returns null when no known ticket vendor is linked", () => {
    const none: DiscoveredLink[] = [
      { url: "https://facebook.com/x", text: "Facebook" },
      { url: "https://mainecheesefestival.org/?page_id=30", text: "Sponsors" },
    ];
    expect(selectTicketVendorLink(none, HOME)).toBeNull();
  });

  it("recognises the common ticketing hosts and rejects an arbitrary one", () => {
    expect(isTicketVendorHost("www.eventbrite.com")).toBe(true);
    expect(isTicketVendorHost("mainecheesefestival.festivalpro.com")).toBe(true);
    expect(isTicketVendorHost("example.com")).toBe(false);
  });
});

describe("extractInlineRoster — against the real roster pages", () => {
  it("reads 34 artisan vendors from the real page", () => {
    const names = extractInlineRoster(fixture.pages.artisan_21.text);
    expect(names).toHaveLength(34);
    expect(names).toContain("27 North");
    expect(names).toContain("Willows Highlands Farm");
  });

  it("reads 21 cheesemakers and 8 food trucks", () => {
    expect(extractInlineRoster(fixture.pages.cheesemakers_57.text)).toHaveLength(21);
    expect(extractInlineRoster(fixture.pages.foodtrucks_61.text)).toHaveLength(8);
  });

  it("totals >= 60 names across the three pages — the acceptance number", () => {
    const all = new Set<string>();
    for (const key of ["artisan_21", "cheesemakers_57", "foodtrucks_61"] as const) {
      for (const n of extractInlineRoster(fixture.pages[key].text)) all.add(n.toLowerCase());
    }
    expect(all.size).toBeGreaterThanOrEqual(60);
    expect(all.size).toBe(63);
  });

  it("keeps a company name whose legal suffix contains the separator", () => {
    // The trap: a naive split(",") turns this into two vendors and mints "Inc".
    const names = extractInlineRoster(fixture.pages.artisan_21.text);
    expect(names).toContain("Barters Island Bees, Inc");
    expect(names).toContain("Dogpatch Farm, LLC");
    expect(names).not.toContain("Inc");
    expect(names).not.toContain("LLC");
  });

  it("drops the conjunction from the final list item", () => {
    const names = extractInlineRoster(fixture.pages.foodtrucks_61.text);
    expect(names).toContain("The Ugly Dumpling");
    expect(names.every((n) => !/^and /i.test(n))).toBe(true);
  });

  it("keeps a trailing abbreviation dot but drops a sentence-ending one", () => {
    expect(splitRosterRun("Alpha Farm, Sojourn Ice Co., Beta Farm.")).toEqual([
      "Alpha Farm",
      "Sojourn Ice Co.",
      "Beta Farm",
    ]);
  });

  it("returns nothing for prose that merely contains commas", () => {
    expect(
      extractInlineRoster("We are open rain or shine, all day, with music, food and fun.")
    ).toEqual([]);
  });

  it("returns nothing without a roster cue", () => {
    expect(extractInlineRoster("Alpha Farm, Beta Farm, Gamma Farm, Delta Farm")).toEqual([]);
  });
});

describe("parseAdmissionPrices — against the real ticketing form", () => {
  const parsed = parseAdmissionPrices(fixture.ticketVendorPage.text);

  it("returns the admission range, not the range of every dollar on the page", () => {
    // Naive min/max over this page returns $0.50-$60.00. Both ends are wrong.
    expect(parsed.min).toBe(10);
    expect(parsed.max).toBe(35);
  });

  it("admits exactly the three admission tiers", () => {
    expect([...new Set(parsed.values)].sort((a, b) => a - b)).toEqual([10, 25, 35]);
  });

  it("rejects booking fees, merchandise and the add-on experience", () => {
    const rejectedAmounts = parsed.rejected.map((r) => r.amount);
    // Positive landmark: assert the rejections actually happened rather than
    // only that the answer looks right, so a parser that stopped matching
    // prices entirely cannot pass this block.
    expect(parsed.rejected.length).toBeGreaterThan(0);
    for (const fee of [0.5, 1.25, 1.75, 2.25]) expect(rejectedAmounts).toContain(fee);
    expect(rejectedAmounts).toContain(60); // Maine Pairings Experience
  });

  it("does not let a preceding sentence lend its admission word to an add-on", () => {
    // The specimen's own case is "...photo ID for age verification upon entry.
    // Maine Pairings Experience $60.00". Asserting only THAT would be a weak
    // test: "Experience" is independently disqualifying, so it would pass even
    // with the sentence cut removed. This input can be decided ONLY by the
    // sentence cut — "Guided Farm Walk" carries neither an admission token nor
    // a disqualifying one, so the verdict turns entirely on whether the label
    // window is allowed to reach back across the period and borrow "entry".
    const p = parseAdmissionPrices(
      "Adult admission is $25. Please present photo ID upon entry. Guided Farm Walk $60.00"
    );
    expect(p.max).toBe(25);
    expect(p.rejected.find((r) => r.amount === 60)?.reason).toBe("no-admission-token");
  });

  it("returns nulls rather than guessing when no price is an admission", () => {
    const none = parseAdmissionPrices("Booth fee: $75.00. Electricity add-on: $20.00.");
    expect(none.min).toBeNull();
    expect(none.max).toBeNull();
  });

  it("handles an empty or absent page", () => {
    expect(parseAdmissionPrices(null).min).toBeNull();
    expect(parseAdmissionPrices("").max).toBeNull();
  });

  it("reads a simple same-page admission line", () => {
    const p = parseAdmissionPrices("Admission $8 for adults, $5 for children under 12.");
    expect(p.min).toBe(5);
    expect(p.max).toBe(8);
  });
});
