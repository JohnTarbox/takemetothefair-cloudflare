/**
 * BC2 (Dev-Email-2026-06-08 §D, 2026-06-08) — unit tests for the blog
 * outbound-link classifier.
 *
 * The MarkdownContent delegated click handler is wired around this
 * pure function so the URL-matching logic is testable without
 * react-testing-library / a jsdom event environment. The classifier
 * is the only piece that can mis-route a click — everything else is
 * gtag/sendBeacon plumbing exercised by the integration smoke test.
 */
import { describe, it, expect } from "vitest";
import { classifyBlogOutboundLink } from "../analytics";

describe("classifyBlogOutboundLink", () => {
  describe("recognized internal links", () => {
    it("classifies /events/<slug> → EVENT", () => {
      expect(classifyBlogOutboundLink("/events/cumberland-fair")).toEqual({
        targetType: "EVENT",
        targetSlug: "cumberland-fair",
      });
    });

    it("classifies /vendors/<slug> → VENDOR", () => {
      expect(classifyBlogOutboundLink("/vendors/maine-cardworks")).toEqual({
        targetType: "VENDOR",
        targetSlug: "maine-cardworks",
      });
    });

    it("classifies /venues/<slug> → VENUE", () => {
      expect(classifyBlogOutboundLink("/venues/cumberland-fairgrounds")).toEqual({
        targetType: "VENUE",
        targetSlug: "cumberland-fairgrounds",
      });
    });

    it("classifies /blog/<slug> → BLOG", () => {
      expect(classifyBlogOutboundLink("/blog/maine-fairs-2026-guide")).toEqual({
        targetType: "BLOG",
        targetSlug: "maine-fairs-2026-guide",
      });
    });

    it("strips trailing query string from targetSlug", () => {
      expect(classifyBlogOutboundLink("/events/cumberland-fair?utm=blog")).toEqual({
        targetType: "EVENT",
        targetSlug: "cumberland-fair",
      });
    });

    it("strips trailing hash from targetSlug", () => {
      expect(classifyBlogOutboundLink("/events/cumberland-fair#schedule")).toEqual({
        targetType: "EVENT",
        targetSlug: "cumberland-fair",
      });
    });

    it("does NOT strip slug suffix that's part of the path", () => {
      // A trailing path segment after the slug would technically match
      // `/events/<slug>/<extra>` — the regex captures only the first
      // segment so we still get the slug, which is the right routing.
      expect(classifyBlogOutboundLink("/events/cumberland-fair/print")).toEqual({
        targetType: "EVENT",
        targetSlug: "cumberland-fair",
      });
    });
  });

  describe("rejected — external / non-internal links", () => {
    it("rejects external absolute URL", () => {
      expect(classifyBlogOutboundLink("https://example.com/events/fair")).toBeNull();
    });

    it("rejects mailto:", () => {
      expect(classifyBlogOutboundLink("mailto:hello@example.com")).toBeNull();
    });

    it("rejects tel:", () => {
      expect(classifyBlogOutboundLink("tel:+12075551234")).toBeNull();
    });

    it("rejects hash-only", () => {
      expect(classifyBlogOutboundLink("#section")).toBeNull();
    });

    it("rejects empty / null / undefined", () => {
      expect(classifyBlogOutboundLink("")).toBeNull();
      expect(classifyBlogOutboundLink(null)).toBeNull();
      expect(classifyBlogOutboundLink(undefined)).toBeNull();
    });

    it("rejects unknown prefixes (/foo, /promoters, /admin)", () => {
      expect(classifyBlogOutboundLink("/foo/bar")).toBeNull();
      expect(classifyBlogOutboundLink("/promoters/maine-promotions")).toBeNull();
      expect(classifyBlogOutboundLink("/admin/events")).toBeNull();
    });

    it("rejects root-only", () => {
      expect(classifyBlogOutboundLink("/")).toBeNull();
    });

    it("rejects /events with no slug", () => {
      expect(classifyBlogOutboundLink("/events")).toBeNull();
      expect(classifyBlogOutboundLink("/events/")).toBeNull();
    });
  });

  describe("absolute meetmeatthefair.com URLs", () => {
    it("classifies absolute apex URL as internal", () => {
      expect(
        classifyBlogOutboundLink("https://meetmeatthefair.com/events/cumberland-fair")
      ).toEqual({
        targetType: "EVENT",
        targetSlug: "cumberland-fair",
      });
    });

    it("classifies absolute www URL as internal", () => {
      expect(
        classifyBlogOutboundLink("https://www.meetmeatthefair.com/vendors/maine-cardworks")
      ).toEqual({
        targetType: "VENDOR",
        targetSlug: "maine-cardworks",
      });
    });

    it("rejects absolute URL with different host", () => {
      expect(classifyBlogOutboundLink("https://other-fair-site.com/events/foo")).toBeNull();
    });
  });
});
