/**
 * Tests for the shared GSC index-state + URL-bucket classifier.
 *
 * Used by /admin/blog (per-post indexation badge) and
 * /admin/stuck-urls (cluster view). Single source of truth — when GSC
 * ships a new coverageState string the fix lands here and both surfaces
 * pick it up.
 */

import { describe, expect, it } from "vitest";
import { classifyIndexState, classifyUrlBucket, extractDetailSlug } from "../gsc-index-state";

describe("classifyIndexState", () => {
  it("returns 'indexed' on PASS verdict regardless of coverageState", () => {
    expect(classifyIndexState("PASS", null)).toBe("indexed");
    expect(classifyIndexState("PASS", "anything else")).toBe("indexed");
    expect(classifyIndexState("SUCCESS", null)).toBe("indexed");
  });

  it("returns 'unknown' when both inputs are null/empty", () => {
    expect(classifyIndexState(null, null)).toBe("unknown");
    expect(classifyIndexState(null, "")).toBe("unknown");
  });

  it("returns 'indexed' for GSC 'Submitted and indexed'", () => {
    expect(classifyIndexState(null, "Submitted and indexed")).toBe("indexed");
  });

  it("returns 'indexed' for 'Indexed, not submitted in sitemap'", () => {
    expect(classifyIndexState(null, "Indexed, not submitted in sitemap")).toBe("indexed");
  });

  it("returns 'discovered_not_indexed' for both en-dash and hyphen variants", () => {
    expect(classifyIndexState(null, "Discovered - currently not indexed")).toBe(
      "discovered_not_indexed"
    );
    expect(classifyIndexState(null, "Discovered – currently not indexed")).toBe(
      "discovered_not_indexed"
    );
  });

  it("returns 'crawled_not_indexed' for the stuck-crawled state", () => {
    expect(classifyIndexState(null, "Crawled - currently not indexed")).toBe("crawled_not_indexed");
  });

  it("returns 'unknown' for unrecognized coverage strings", () => {
    expect(classifyIndexState(null, "Page with redirect")).toBe("unknown");
    expect(classifyIndexState(null, "URL is unknown to Google")).toBe("unknown");
  });

  it("verdict beats coverageState (PASS wins over 'not indexed' string)", () => {
    expect(classifyIndexState("PASS", "Discovered - currently not indexed")).toBe("indexed");
  });
});

describe("classifyUrlBucket", () => {
  it("classifies event detail URLs", () => {
    expect(classifyUrlBucket("https://meetmeatthefair.com/events/2026-vermont-fair")).toBe("event");
  });

  it("classifies event state-listing URLs (not detail)", () => {
    expect(classifyUrlBucket("https://meetmeatthefair.com/events/maine")).toBe("event_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/events/vermont")).toBe("event_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/events/craft-fairs")).toBe(
      "event_listing"
    );
  });

  it("classifies event listing root", () => {
    expect(classifyUrlBucket("https://meetmeatthefair.com/events")).toBe("event_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/events/")).toBe("event_listing");
  });

  it("classifies vendor / venue / promoter / blog detail and listing", () => {
    expect(classifyUrlBucket("https://meetmeatthefair.com/vendors/anyhand")).toBe("vendor");
    expect(classifyUrlBucket("https://meetmeatthefair.com/vendors")).toBe("vendor_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/venues/town-hall")).toBe("venue");
    expect(classifyUrlBucket("https://meetmeatthefair.com/venues")).toBe("venue_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/promoters/acme")).toBe("promoter");
    expect(classifyUrlBucket("https://meetmeatthefair.com/blog/why-vendors-cant-stop")).toBe(
      "blog"
    );
    expect(classifyUrlBucket("https://meetmeatthefair.com/blog")).toBe("blog_listing");
    expect(classifyUrlBucket("https://meetmeatthefair.com/blog/tag/maine")).toBe("blog_listing");
  });

  it("returns 'other' for unrecognized / unparseable URLs", () => {
    expect(classifyUrlBucket("https://meetmeatthefair.com/about")).toBe("other");
    expect(classifyUrlBucket("not-a-url")).toBe("other");
    expect(classifyUrlBucket("https://meetmeatthefair.com/")).toBe("event_listing"); // root collapses to event_listing per current spec
  });
});

describe("extractDetailSlug", () => {
  it("extracts slug for event detail URL", () => {
    expect(extractDetailSlug("https://meetmeatthefair.com/events/2026-fair", "event")).toBe(
      "2026-fair"
    );
  });

  it("extracts slug for vendor / venue / promoter / blog", () => {
    expect(extractDetailSlug("https://meetmeatthefair.com/vendors/anyhand", "vendor")).toBe(
      "anyhand"
    );
    expect(extractDetailSlug("https://meetmeatthefair.com/venues/hall", "venue")).toBe("hall");
    expect(extractDetailSlug("https://meetmeatthefair.com/promoters/acme", "promoter")).toBe(
      "acme"
    );
    expect(extractDetailSlug("https://meetmeatthefair.com/blog/post-slug", "blog")).toBe(
      "post-slug"
    );
  });

  it("returns null for listing-bucket URLs", () => {
    expect(extractDetailSlug("https://meetmeatthefair.com/events", "event_listing")).toBe(null);
    expect(extractDetailSlug("https://meetmeatthefair.com/blog", "blog_listing")).toBe(null);
  });

  it("returns null for 'other' bucket", () => {
    expect(extractDetailSlug("https://meetmeatthefair.com/about", "other")).toBe(null);
  });

  it("returns null for unparseable URL", () => {
    expect(extractDetailSlug("not-a-url", "event")).toBe(null);
  });
});
