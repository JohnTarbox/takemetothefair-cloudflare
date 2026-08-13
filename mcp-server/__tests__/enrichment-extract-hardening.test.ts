/**
 * OPE-249 — extractor hardening. Each case is a raw value observed live in the
 * 2026-07-17 batch review (candidate ids in comments). Acceptance #1: every
 * cited dirty input either normalizes clean or is filtered/flagged — no dirty
 * value stages clean. Fixes land in the shared vendor extractor, so they cover
 * the promoter path too (promoter-extract reuses extractVendorContact).
 */
import { describe, it, expect } from "vitest";
import {
  extractVendorContact,
  normalizePhone,
  isPlaceholderEmail,
  isPlaceholderPhone,
  emailHasDomainAffinity,
} from "../src/enrichment/extract.js";

describe("OPE-249 #1 — tel normalization + NANP validation", () => {
  it("URL-decodes + cleans the cited dirty tel values to canonical form", () => {
    expect(normalizePhone("%20(603)%20547-3442")).toBe("(603) 547-3442"); // promoter #848
    expect(normalizePhone("%20603-446-3326")).toBe("(603) 446-3326"); // promoter #847
    expect(normalizePhone("&#x2B;1(207)892-9606")).toBe("(207) 892-9606"); // vendor #3928 (&#x2B; = +)
  });
  it("rejects an impossible NANP number scraped from a numeric id", () => {
    expect(normalizePhone("1846151813")).toBeNull(); // promoter #936 — area code 184
  });
  it("rejects area/exchange codes starting 0 or 1", () => {
    expect(normalizePhone("(123) 456-7890")).toBeNull();
    expect(normalizePhone("(603) 147-3442")).toBeNull(); // exchange 147
  });
  it("strips a US country code and accepts a clean number", () => {
    expect(normalizePhone("+1 603 547 3442")).toBe("(603) 547-3442");
    expect(normalizePhone("6035473442")).toBe("(603) 547-3442");
  });
});

describe("OPE-249 #2/#3 — social URL filtering (via the extractor)", () => {
  const wrap = (href: string) => `<html><body><a href="${href}">x</a></body></html>`;

  it("rejects a YouTube video/share link as the org channel (promoter #860/#857)", () => {
    expect(
      extractVendorContact(wrap("https://youtu.be/abc123?si=xyz"), "https://ex.com").social
    ).toBeUndefined();
    expect(
      extractVendorContact(wrap("https://youtube.com/watch?v=abc"), "https://ex.com").social
    ).toBeUndefined();
  });
  it("accepts a real YouTube channel/handle", () => {
    const out = extractVendorContact(
      wrap("https://youtube.com/@meetmeatthefair"),
      "https://ex.com"
    );
    expect(out.social?.value.youtube).toBe("https://youtube.com/@meetmeatthefair");
  });
  it("rejects an Instagram hashtag/explore URL as a profile (vendor #3959)", () => {
    expect(
      extractVendorContact(wrap("https://instagram.com/explore/tags/biwaa/"), "https://ex.com")
        .social
    ).toBeUndefined();
  });
  it("accepts a real Instagram profile", () => {
    const out = extractVendorContact(
      wrap("https://instagram.com/meet.me.at.the.fair"),
      "https://ex.com"
    );
    expect(out.social?.value.instagram).toBe("https://instagram.com/meet.me.at.the.fair");
  });
});

describe("OPE-249 #4 — placeholder-email denylist", () => {
  it("flags the cited GoDaddy template residue + siblings", () => {
    expect(isPlaceholderEmail("filler@godaddy.com")).toBe(true); // promoter #863
    expect(isPlaceholderEmail("test@wix.com")).toBe(true);
    expect(isPlaceholderEmail("hi@example.com")).toBe(true);
    expect(isPlaceholderEmail("x@abc123.wixpress.com")).toBe(true);
    expect(isPlaceholderEmail("not-an-email")).toBe(true); // malformed → never clean
  });
  it("passes a real business email", () => {
    expect(isPlaceholderEmail("info@fryeburgfair.org")).toBe(false);
  });
  it("does not stage a placeholder email from the extractor", () => {
    const html = `<a href="mailto:filler@godaddy.com">email</a>`;
    expect(extractVendorContact(html, "https://ex.com").email).toBeUndefined();
  });
});

describe("OPE-249 #5 — regex-email domain affinity", () => {
  it("accepts a generic mailbox at any domain", () => {
    expect(emailHasDomainAffinity("info@anything.com", "https://promoter.org")).toBe(true);
  });
  it("accepts an email whose domain matches the site", () => {
    expect(emailHasDomainAffinity("k@granitemediagroup.com", "https://granitemediagroup.com")).toBe(
      true
    );
  });
  it("rejects a personal email at a THIRD domain (promoter #894)", () => {
    expect(
      emailHasDomainAffinity("kkeating@granitemediagroup.com", "https://somepromoter.org")
    ).toBe(false);
  });
  it("stages a non-affinity regex email BELOW the clean bar, not dropped", () => {
    const html = `<html><body>Reach us: kkeating@granitemediagroup.com</body></html>`;
    const out = extractVendorContact(html, "https://somepromoter.org");
    expect(out.email?.method).toBe("regex");
    expect(out.email?.confidence).toBeLessThan(0.3); // flagged, not clean
  });
});

describe("OPE-249 #6 — multi-location address disambiguation", () => {
  const twoLocationJsonLd = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [
      {
        "@type": "LocalBusiness",
        address: {
          streetAddress: "111 Mass Ave",
          addressLocality: "North Adams",
          addressRegion: "MA",
        },
      },
      {
        "@type": "LocalBusiness",
        address: {
          streetAddress: "109 Apremont Way",
          addressLocality: "Westfield",
          addressRegion: "MA",
        },
      },
    ],
  })}</script>`;

  it("does NOT stage an address when the page lists multiple locations (vendor #3956)", () => {
    const out = extractVendorContact(twoLocationJsonLd, "https://brightideasbrewing.com");
    expect(out.address).toBeUndefined();
    expect(out.city).toBeUndefined();
  });
  it("stages the address when the page names exactly one location", () => {
    const single = `<script type="application/ld+json">${JSON.stringify({
      "@type": "LocalBusiness",
      address: {
        streetAddress: "111 Mass Ave",
        addressLocality: "North Adams",
        addressRegion: "MA",
      },
    })}</script>`;
    const out = extractVendorContact(single, "https://brightideasbrewing.com");
    expect(out.address?.value).toBe("111 Mass Ave");
    expect(out.city?.value).toBe("North Adams");
    expect(out.state?.value).toBe("MA");
  });
});

/**
 * OPE-376 — the 7th defect class. `normalizePhone` proves a number is
 * well-FORMED; nothing proved it was real, so template residue staged clean at
 * confidence 0.90 straight from a vendor's own JSON-LD.
 *
 * Both specimens below are live prod rows read 2026-08-13, still `pending`.
 */
describe("OPE-376 — placeholder-phone denylist", () => {
  it("rejects the two fictitious numbers found staged clean in prod", () => {
    // vendor_enrichment_candidates #6419, CJ Pickering Enterprises, conf 0.90,
    // flags none — the row this ticket was filed on.
    expect(isPlaceholderPhone("(508) 555-9876")).toBe(true);
    // The one the ticket did not know about: 555 AREA code as well.
    expect(isPlaceholderPhone("(555) 555-5555")).toBe(true);
  });

  it("still passes normalizePhone — which is exactly why this guard is needed", () => {
    // If normalizePhone rejected these, the denylist would be redundant. It
    // does not: they are perfectly well-formed NANP numbers.
    expect(normalizePhone("(508) 555-9876")).toBe("(508) 555-9876");
    expect(normalizePhone("(555) 555-5555")).toBe("(555) 555-5555");
  });

  it("exempts 555-1212 — real directory assistance, not a fake", () => {
    expect(isPlaceholderPhone("(508) 555-1212")).toBe(false);
  });

  it("catches sequential and repeated subscriber digits", () => {
    // 234-5678 is well-formed (NXX starts 2) and DOES reach the denylist.
    expect(isPlaceholderPhone("(603) 234-5678")).toBe(true);
    expect(isPlaceholderPhone("(603) 876-5432")).toBe(true); // descending
    expect(isPlaceholderPhone("(603) 222-2222")).toBe(true); // repeated
  });

  it("leaves genuine numbers alone", () => {
    // Real vendor numbers from the OPE-249 corpus above.
    expect(isPlaceholderPhone("(603) 547-3442")).toBe(false);
    expect(isPlaceholderPhone("(207) 892-9606")).toBe(false);
    expect(isPlaceholderPhone("(603) 446-3326")).toBe(false);
  });

  it("treats a non-canonical value as placeholder rather than clean", () => {
    // Mirrors isPlaceholderEmail's handling of a malformed address: if we
    // cannot read it, it must never stage as a verified contact.
    expect(isPlaceholderPhone("call us!")).toBe(true);
    expect(isPlaceholderPhone("")).toBe(true);
  });
});
