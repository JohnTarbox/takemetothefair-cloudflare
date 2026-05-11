import { describe, it, expect } from "vitest";
import {
  buildEventMetaDescription,
  buildEventTitle,
  buildVendorMetaDescription,
  buildVenueMetaDescription,
  isCleanDbDescription,
  stripRedundantLeadSentence,
  trimTrailingFunctionWord,
} from "../seo-utils";

// ─── HTML entity decoding (regression: PR #80 behavior preserved) ────

describe("buildEventMetaDescription — HTML entity decoding", () => {
  it("decodes &amp; in event name", () => {
    const out = buildEventMetaDescription({
      name: "Earth Expo &amp; Convention",
      description: null,
    });
    expect(out).toContain("Earth Expo & Convention");
    expect(out).not.toContain("&amp;");
  });

  it("decodes entities in venue name", () => {
    const out = buildEventMetaDescription({
      name: "Spring Fair",
      description: null,
      venue: { name: "Smith &amp; Sons Park", city: "Boston", state: "MA" },
    });
    expect(out).toContain("Smith & Sons Park");
    expect(out).not.toContain("&amp;");
  });

  it("decodes &#039; in description", () => {
    const out = buildEventMetaDescription({
      name: "Children's Festival",
      description:
        "Bring the kids — there&#039;s face painting, games, and food trucks all weekend long!",
    });
    expect(out).toContain("there's");
    expect(out).not.toContain("&#039;");
  });
});

describe("buildVendorMetaDescription — HTML entity decoding", () => {
  it("decodes &amp; in business name", () => {
    const out = buildVendorMetaDescription({
      businessName: "Smith &amp; Co. Bakery",
      vendorType: "Bakery",
    });
    expect(out).toContain("Smith & Co. Bakery");
    expect(out).not.toContain("&amp;");
  });

  it("decodes entities in description", () => {
    const out = buildVendorMetaDescription({
      businessName: "Test Vendor",
      description:
        "Hand-crafted goods made with care &mdash; we&#039;ve been at the fair for 20 years and counting.",
    });
    expect(out).toContain("we've been");
    expect(out).not.toContain("&#039;");
  });
});

describe("buildVenueMetaDescription — HTML entity decoding", () => {
  it("decodes &amp; in venue name", () => {
    const out = buildVenueMetaDescription({
      name: "Smith &amp; Sons Pavilion",
    });
    expect(out).toContain("Smith & Sons Pavilion");
    expect(out).not.toContain("&amp;");
  });
});

// ─── trimTrailingFunctionWord helper ─────────────────────────────────

describe("trimTrailingFunctionWord", () => {
  it("strips trailing 'and' with preceding comma", () => {
    expect(trimTrailingFunctionWord("locally grown produce, handmade crafts, and")).toBe(
      "locally grown produce, handmade crafts"
    );
  });

  it("strips trailing 'for'", () => {
    expect(trimTrailingFunctionWord("open their doors for")).toBe("open their doors");
  });

  it("strips trailing 'the'", () => {
    expect(trimTrailingFunctionWord("transforms historic Dock Square and the")).toBe(
      "transforms historic Dock Square"
    );
  });

  it("strips trailing 'of'", () => {
    expect(trimTrailingFunctionWord("celebration of")).toBe("celebration");
  });

  it("does not strip when text ends with content word", () => {
    expect(trimTrailingFunctionWord("locally grown produce")).toBe("locally grown produce");
  });

  it("does not strip middle-of-string function words", () => {
    expect(trimTrailingFunctionWord("the quick brown fox")).toBe("the quick brown fox");
  });

  it("strips multiple trailing function words", () => {
    expect(trimTrailingFunctionWord("artisan and small business and the")).toBe(
      "artisan and small business"
    );
  });

  it("strips trailing em-dash and function word", () => {
    expect(trimTrailingFunctionWord("food vendors — and")).toBe("food vendors");
  });

  it("preserves trailing periods (sentence completions)", () => {
    expect(trimTrailingFunctionWord("Locally grown produce.")).toBe("Locally grown produce.");
  });
});

// ─── isCleanDbDescription quality gate ────────────────────────────────

describe("isCleanDbDescription", () => {
  it("accepts a normal description", () => {
    expect(
      isCleanDbDescription(
        "Locally grown produce, handmade crafts, prepared food, live entertainment."
      )
    ).toBe(true);
  });

  it("rejects null and empty", () => {
    expect(isCleanDbDescription(null)).toBe(false);
    expect(isCleanDbDescription(undefined)).toBe(false);
    expect(isCleanDbDescription("")).toBe(false);
    expect(isCleanDbDescription("   ")).toBe(false);
  });

  it("rejects too short (<30 chars)", () => {
    expect(isCleanDbDescription("Too short")).toBe(false);
  });

  it("rejects too long (>5000 chars)", () => {
    expect(isCleanDbDescription("a".repeat(5001))).toBe(false);
  });

  it("rejects 'Contact:' prefix (import garbage)", () => {
    expect(isCleanDbDescription("Contact: Jane Doe at jane@example.com for details")).toBe(false);
  });

  it("rejects 'Imported from' prefix", () => {
    expect(isCleanDbDescription("Imported from oldsite.example.com - last updated 2019")).toBe(
      false
    );
  });

  it("rejects '[Name]' template placeholder", () => {
    expect(isCleanDbDescription("[Name] will be hosting an event this weekend")).toBe(false);
  });

  it("rejects SHOUTY ALL CAPS (>40% upper)", () => {
    expect(
      isCleanDbDescription("VENDORS WANTED FOR HUGE EVENT - APPLY NOW BY CALLING THE NUMBER ABOVE")
    ).toBe(false);
  });

  it("accepts mixed case description with proper nouns", () => {
    expect(
      isCleanDbDescription(
        "The Vermont Maple Sugar Makers' Association hosts this annual event each March."
      )
    ).toBe(true);
  });
});

// ─── stripRedundantLeadSentence heuristic ────────────────────────────

describe("stripRedundantLeadSentence", () => {
  it("strips a leading 'X will be held on DATE' sentence", () => {
    const out = stripRedundantLeadSentence(
      "Portland World Oddities Expo will be held on March 21-22, 2026. This is a celebration of all things weird.",
      "Portland World Oddities Expo"
    );
    expect(out).toBe("This is a celebration of all things weird.");
  });

  it("strips when event name has '20XX' prefix and DB content drops it", () => {
    const out = stripRedundantLeadSentence(
      "Brattleboro Area Indoor Farmers Market will be held on March 7th, 2026. Locally grown produce.",
      "2026 Brattleboro Area Indoor Farmers Market"
    );
    expect(out).toBe("Locally grown produce.");
  });

  it("leaves alone when first sentence has no event name", () => {
    const out = stripRedundantLeadSentence(
      "Locally grown produce and handmade crafts. Saturday hours 10am-2pm.",
      "Brattleboro Farmers Market"
    );
    expect(out).toBe("Locally grown produce and handmade crafts. Saturday hours 10am-2pm.");
  });

  it("leaves alone when first sentence has name but no date", () => {
    const out = stripRedundantLeadSentence(
      "Portland Golf Expo brings together the best clubs and gear. Open all weekend.",
      "Portland Golf Expo"
    );
    expect(out).toContain("Portland Golf Expo brings together");
  });

  it("leaves alone when first sentence is too long (>200 chars)", () => {
    const longFirst =
      "Portland Golf Expo will be held on March 21, 2026, and we expect record attendance based on early ticket sales, with vendors traveling from across New England plus a number of celebrity endorsers we're excited to announce shortly. The event runs all weekend.";
    const out = stripRedundantLeadSentence(longFirst, "Portland Golf Expo");
    expect(out).toContain("Portland Golf Expo will be held");
  });
});

// ─── buildEventTitle ─────────────────────────────────────────────────

describe("buildEventTitle", () => {
  it("appends '· City, ST' when neither appears in name", () => {
    expect(
      buildEventTitle({
        name: "Spring Craft Fair",
        venue: { city: "Boston", state: "MA" },
      })
    ).toBe("Spring Craft Fair · Boston, MA");
  });

  it("skips city suffix when name already contains the city", () => {
    // Kennebunkport is in the name → drop city, keep state code
    expect(
      buildEventTitle({
        name: "45th Annual Kennebunkport Christmas Prelude",
        venue: { city: "Kennebunkport", state: "ME" },
      })
    ).toBe("45th Annual Kennebunkport Christmas Prelude · ME");
  });

  it("skips state suffix when name contains the full state name", () => {
    // "Vermont" in the name → no suffix at all
    expect(
      buildEventTitle({
        name: "Vermont Maple Open House Weekend 2027",
        venue: null,
        stateCode: "VT",
      })
    ).toBe("Vermont Maple Open House Weekend 2027");
  });

  it("uses 'Statewide ${StateName}' for is_statewide events", () => {
    expect(
      buildEventTitle({
        name: "207 Beer Week",
        isStatewide: true,
        stateCode: "ME",
      })
    ).toBe("207 Beer Week · Statewide Maine");
  });

  it("returns just the name when no venue and no stateCode", () => {
    expect(
      buildEventTitle({
        name: "Mystery Pop-Up",
      })
    ).toBe("Mystery Pop-Up");
  });

  it("decodes HTML entities in the name", () => {
    expect(
      buildEventTitle({
        name: "Earth Expo &amp; Convention",
        venue: { city: "Boston", state: "MA" },
      })
    ).toBe("Earth Expo & Convention · Boston, MA");
  });

  it("does NOT include the brand suffix", () => {
    const out = buildEventTitle({
      name: "Spring Fair",
      venue: { city: "Boston", state: "MA" },
    });
    expect(out).not.toContain("Meet Me at the Fair");
  });
});

// ─── buildEventMetaDescription — Option 3 with quality gate hybrid ───

describe("buildEventMetaDescription — clean DB description leads (no suffix, round-2 2026-05-11)", () => {
  it("Brattleboro Indoor Farmers Market: strips redundant lead sentence, returns cleaned desc verbatim (no date suffix)", () => {
    const out = buildEventMetaDescription({
      name: "2026 Brattleboro Area Indoor Farmers Market",
      description:
        "Brattleboro Area Indoor Farmers Market will be held on March 7th, 2026. This market will feature locally grown produce, handmade crafts, prepared food, live entertainment, and more. Hours: 10am-2pm",
      categories: '["Farmers Market"]',
      venue: { name: "Winston Prouty Center", city: "Brattleboro", state: "VT" },
      startDate: new Date("2026-03-07T00:00:00Z"),
      endDate: new Date("2026-03-07T00:00:00Z"),
    });
    expect(out).not.toContain("will be held on March 7th");
    expect(out).toContain("locally grown produce");
    // No date suffix anymore — title and rendered card cover the date.
    expect(out).not.toContain("Mar 7, 2026");
    // No venue suffix either.
    expect(out).not.toContain("Winston Prouty Center");
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("Vermont Maple: long DB description, truncates at first-sentence period (no date suffix)", () => {
    const out = buildEventMetaDescription({
      name: "Vermont Maple Open House Weekend 2027",
      description:
        "Free statewide weekend event hosted by the Vermont Maple Sugar Makers' Association. Over 80 sugarhouses across Vermont open their doors for tours, tastings, live music, and maple treats during peak sugaring season.",
      categories: '["Festival","Community Event"]',
      venue: null,
      startDate: new Date("2027-03-26T00:00:00Z"),
      endDate: new Date("2027-03-27T00:00:00Z"),
    });
    expect(out).toContain("Vermont Maple Sugar Makers");
    // Description carries no year, and we no longer append a date suffix.
    expect(out).not.toMatch(/\b2027\b/);
    // Should cut at the period after "Association."
    expect(out).toContain("Association.");
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("Kennebunkport Christmas Prelude: no clause break within 160 chars, falls back to word boundary", () => {
    const desc =
      "The 45th Annual Kennebunkport Christmas Prelude transforms historic Dock Square and the Lower Village of Kennebunkport into an 11-day celebration of holiday traditions. Highlights include the official Tree Lighting Ceremony, Santa's arrival up the Kennebunk River on Sunday, Dec 6, strolling carolers, live music, food vendors, ice carving, fireworks";
    const out = buildEventMetaDescription({
      name: "45th Annual Kennebunkport Christmas Prelude",
      description: desc,
      categories: '["Festival","Holiday Market","Community Event"]',
      venue: {
        name: "Dock Square / Downtown Kennebunkport",
        city: "Kennebunkport",
        state: "ME",
      },
      startDate: new Date("2026-12-04T00:00:00Z"),
      endDate: new Date("2026-12-13T00:00:00Z"),
    });
    expect(out).toContain("Kennebunkport Christmas Prelude");
    // No date suffix.
    expect(out).not.toContain("Dec 4-13, 2026");
    // Output is a clean prefix of the description (no garbage appended,
    // no mid-word truncation — proves word-boundary fallback worked).
    expect(desc.startsWith(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("Fryeburg-style: description fits in 160 chars, returned verbatim with no truncation", () => {
    // The audit's canonical example — 144 chars including em-dash. Should
    // pass through verbatim, no mid-word "drawing Oct 4-11" garbage.
    const out = buildEventMetaDescription({
      name: "Fryeburg Fair",
      description:
        "Maine's Blue Ribbon Classic Agricultural Fair since 1851 — the state's largest agricultural fair, drawing 260,000 attendees annually.",
      categories: '["Fair"]',
      venue: { name: "Fryeburg Fairgrounds", city: "Fryeburg", state: "ME" },
      startDate: new Date("2026-10-04T00:00:00Z"),
      endDate: new Date("2026-10-11T00:00:00Z"),
    });
    expect(out).toContain("260,000 attendees annually");
    expect(out).not.toContain("Oct 4-11");
    expect(out).not.toContain("Fryeburg Fairgrounds, Fryeburg ME");
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("description with semicolon clause break: cuts at the semicolon and strips it", () => {
    // 230 chars total; first ';' at ~95 chars. Should cut there and strip the ;.
    const out = buildEventMetaDescription({
      name: "Big Event",
      description:
        "Three days of fun events for the whole family with live music and great food for everyone; this also includes a children's area, vendor booths, beer garden, and a Sunday parade through downtown.",
      categories: null,
      venue: null,
      startDate: null,
      endDate: null,
    });
    expect(out).toContain("live music and great food");
    // The semicolon should be stripped (suggests continuation).
    expect(out).not.toMatch(/;\s*$/);
    expect(out.length).toBeLessThanOrEqual(160);
  });
});

describe("buildEventMetaDescription — fallback when DB description fails gate (natural-language, round-2 2026-05-11)", () => {
  it("Portland Golf Expo: empty description, full fallback form", () => {
    const out = buildEventMetaDescription({
      name: "Portland Golf Expo",
      description: null,
      categories: '["Trade Show"]',
      venue: {
        name: "Holiday Inn Portland-By The Bay",
        city: "Portland",
        state: "ME",
      },
      startDate: new Date("2026-01-28T13:00:00Z"),
      endDate: new Date("2026-01-29T13:00:00Z"),
    });
    // Natural-language form: "{name} happening {date} at {venue} in {city}, {state}. {category}."
    expect(out).toBe(
      "Portland Golf Expo happening Jan 28-29, 2026 at Holiday Inn Portland-By The Bay in Portland, ME. Trade Show."
    );
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("177th Franklin County Fair: empty description, multi-day", () => {
    const out = buildEventMetaDescription({
      name: "177th Franklin County Fair",
      description: "",
      categories: '["Fair"]',
      venue: { name: "Franklin County Fairgrounds", city: "Greenfield", state: "MA" },
      startDate: new Date("2026-09-09T00:00:00Z"),
      endDate: new Date("2026-09-12T00:00:00Z"),
    });
    expect(out).toContain("Franklin County Fairgrounds");
    expect(out).toContain("Fair");
    expect(out).toContain("happening");
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("Garbage 'Contact:' description triggers fallback even though length is OK", () => {
    const out = buildEventMetaDescription({
      name: "Test Event",
      description: "Contact: Jane Doe at jane@example.com for application details and pricing.",
      categories: '["Festival"]',
      venue: { name: "Test Venue", city: "Boston", state: "MA" },
      startDate: new Date("2026-06-15T00:00:00Z"),
      endDate: new Date("2026-06-15T00:00:00Z"),
    });
    expect(out).not.toContain("Contact: Jane");
    expect(out).toContain("Festival");
    expect(out).toContain("happening Jun 15, 2026");
  });

  it("fallback gracefully omits 'happening' when no dates", () => {
    const out = buildEventMetaDescription({
      name: "Test Event",
      description: null,
      categories: '["Festival"]',
      venue: { name: "Test Venue", city: "Boston", state: "MA" },
      startDate: null,
      endDate: null,
    });
    expect(out).toBe("Test Event at Test Venue in Boston, MA. Festival.");
  });

  it("fallback gracefully omits 'at venue' when no venue", () => {
    const out = buildEventMetaDescription({
      name: "Test Event",
      description: null,
      categories: '["Festival"]',
      venue: null,
      startDate: new Date("2026-06-15T00:00:00Z"),
      endDate: new Date("2026-06-15T00:00:00Z"),
    });
    expect(out).toBe("Test Event happening Jun 15, 2026. Festival.");
  });
});

describe("buildVendorMetaDescription — fallback templates (round-2 2026-05-11)", () => {
  it("empty description, vendorType + city/state: full fallback form", () => {
    const out = buildVendorMetaDescription({
      businessName: "Maine Cardworks",
      description: null,
      vendorType: "Trading Cards",
      city: "Portland",
      state: "ME",
    });
    expect(out).toBe(
      "Maine Cardworks — Trading Cards vendor based in Portland, ME. View upcoming events on Meet Me at the Fair."
    );
  });

  it("empty description, vendorType, no location (half of vendors)", () => {
    const out = buildVendorMetaDescription({
      businessName: "Vintage Jewelry",
      description: null,
      vendorType: "Antiques",
    });
    expect(out).toBe(
      "Vintage Jewelry — Antiques vendor. View upcoming events on Meet Me at the Fair."
    );
  });

  it("empty description, no vendorType, no location: name + boilerplate", () => {
    const out = buildVendorMetaDescription({
      businessName: "Vendor Name Only",
      description: null,
    });
    expect(out).toBe("Vendor Name Only. View upcoming events on Meet Me at the Fair.");
  });
});

describe("buildVenueMetaDescription — fallback templates (round-2 2026-05-11)", () => {
  it("empty description, with city/state: full fallback form", () => {
    const out = buildVenueMetaDescription({
      name: "Cumberland County Fairgrounds",
      description: null,
      city: "Cumberland",
      state: "ME",
    });
    expect(out).toBe(
      "Cumberland County Fairgrounds is an event venue in Cumberland, ME. View upcoming fairs, festivals, and shows on Meet Me at the Fair."
    );
  });

  it("empty description, no location", () => {
    const out = buildVenueMetaDescription({
      name: "Mystery Pavilion",
      description: null,
    });
    expect(out).toBe(
      "Mystery Pavilion is an event venue. View upcoming fairs, festivals, and shows on Meet Me at the Fair."
    );
  });

  it("amenities are no longer pulled into the fallback (kept clean)", () => {
    const out = buildVenueMetaDescription({
      name: "Big Hall",
      description: null,
      city: "Boston",
      state: "MA",
      amenities: '["Parking","Restrooms","Wi-Fi"]',
    });
    expect(out).not.toContain("Parking");
    expect(out).not.toContain("Featuring");
    expect(out).toContain("is an event venue");
  });
});

describe("buildEventMetaDescription — null/missing dates and venues", () => {
  it("207 Beer Week: statewide, no venue, no dates, has DB description", () => {
    const out = buildEventMetaDescription({
      name: "207 Beer Week",
      description:
        "Annual week-long celebration of Maine's craft brewing industry, organized by the Maine Brewers' Guild. Distributed event with sub-events at participating breweries, beer bars, and beer-loving restaurants across Maine, from Kittery to Fort Kent.",
      categories: '["Festival"]',
      venue: null,
      startDate: null,
      endDate: null,
    });
    expect(out).toContain("Maine's craft brewing industry");
    // No date suffix when dates are NULL
    expect(out).not.toMatch(/\b202\d\b/);
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("event with no venue and no dates and no description: minimal fallback", () => {
    const out = buildEventMetaDescription({
      name: "Mystery Pop-Up",
      description: null,
      categories: null,
      venue: null,
      startDate: null,
      endDate: null,
    });
    expect(out).toContain("Mystery Pop-Up");
    expect(out.length).toBeLessThanOrEqual(160);
  });
});
