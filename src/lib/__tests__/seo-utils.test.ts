import { describe, it, expect } from "vitest";
import {
  buildEventMetaDescription,
  buildVendorMetaDescription,
  buildVenueMetaDescription,
} from "../seo-utils";

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
