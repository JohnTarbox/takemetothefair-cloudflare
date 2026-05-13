/**
 * Unit tests for buildUtmUrl — the pure helper behind the build_utm_url
 * MCP tool. Pure function, no D1, no fetch.
 */
import { describe, expect, it } from "vitest";
import { buildUtmUrl } from "../src/utm.js";

describe("buildUtmUrl — happy path", () => {
  it("composes a tagged URL with required params", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/events/fryeburg-fair-2026",
      source: "facebook",
      medium: "social",
      campaign: "weekend-roundup",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(
      "https://meetmeatthefair.com/events/fryeburg-fair-2026?utm_source=facebook&utm_medium=social&utm_campaign=weekend-roundup"
    );
    expect(result.source).toBe("facebook");
    expect(result.medium).toBe("social");
    expect(result.campaign).toBe("weekend-roundup");
    expect(result.content).toBeNull();
    expect(result.term).toBeNull();
  });

  it("includes optional content and term when provided", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/blog/maine-fairs-2026",
      source: "facebook",
      medium: "social",
      campaign: "pillar-launch",
      content: "carousel-card-1",
      term: "maine fairs 2026",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("utm_content=carousel-card-1");
    expect(result.url).toContain("utm_term=maine-fairs-2026");
    expect(result.content).toBe("carousel-card-1");
    expect(result.term).toBe("maine-fairs-2026");
  });

  it("accepts the www. host variant", () => {
    const result = buildUtmUrl({
      url: "https://www.meetmeatthefair.com/venues/fryeburg-fairgrounds",
      source: "facebook",
      medium: "social",
      campaign: "venue-spotlight",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts http (not just https)", () => {
    const result = buildUtmUrl({
      url: "http://meetmeatthefair.com/",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(true);
  });

  it("preserves existing non-utm query params", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/events?state=ME&category=fairs",
      source: "facebook",
      medium: "social",
      campaign: "maine-roundup",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("state=ME");
    expect(result.url).toContain("category=fairs");
    expect(result.url).toContain("utm_source=facebook");
  });

  it("preserves URL fragments", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/events/fryeburg-fair-2026#tickets",
      source: "facebook",
      medium: "social",
      campaign: "weekend",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("#tickets");
  });
});

describe("buildUtmUrl — UTM sanitization", () => {
  it("lowercases and slug-formats source/medium/campaign", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/",
      source: "Facebook",
      medium: "Social Media",
      campaign: "Weekend Roundup 2026-05-12",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("facebook");
    expect(result.medium).toBe("social-media");
    expect(result.campaign).toBe("weekend-roundup-2026-05-12");
  });

  it("strips punctuation from params", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/",
      source: "facebook!",
      medium: "social_media",
      campaign: "weekend@roundup",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("facebook");
    // createSlug strips underscores
    expect(result.medium).toBe("socialmedia");
    expect(result.campaign).toBe("weekendroundup");
  });

  it("rejects params that sanitize to empty strings", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/",
      source: "!!!",
      medium: "social",
      campaign: "weekend",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/source.*medium.*campaign/);
  });
});

describe("buildUtmUrl — host restriction", () => {
  it("rejects non-meetmeatthefair hosts", () => {
    const result = buildUtmUrl({
      url: "https://competitor.com/events",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("meetmeatthefair.com");
    expect(result.error).toContain("competitor.com");
  });

  it("rejects look-alike hosts", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.evil.com/events",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects subdomains we haven't allowlisted", () => {
    const result = buildUtmUrl({
      url: "https://api.meetmeatthefair.com/events",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
  });
});

describe("buildUtmUrl — input validation", () => {
  it("rejects non-URL strings", () => {
    const result = buildUtmUrl({
      url: "not a url",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid URL");
  });

  it("rejects non-http schemes", () => {
    const result = buildUtmUrl({
      url: "ftp://meetmeatthefair.com/file.zip",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("scheme");
  });

  it("rejects javascript: scheme", () => {
    const result = buildUtmUrl({
       
      url: "javascript:alert(1)",
      source: "facebook",
      medium: "social",
      campaign: "test",
    });
    expect(result.ok).toBe(false);
  });
});

describe("buildUtmUrl — re-tagging behavior", () => {
  it("replaces existing utm_* params instead of appending duplicates", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/events?utm_source=old-source&utm_medium=old-medium&utm_campaign=old-campaign",
      source: "facebook",
      medium: "social",
      campaign: "new-campaign",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should only have one utm_source, and it should be the new value
    const sourceMatches = result.url.match(/utm_source=/g);
    expect(sourceMatches?.length).toBe(1);
    expect(result.url).toContain("utm_source=facebook");
    expect(result.url).not.toContain("old-source");
  });

  it("clears optional utm_content and utm_term when re-tagging without them", () => {
    const result = buildUtmUrl({
      url: "https://meetmeatthefair.com/events?utm_source=fb&utm_medium=social&utm_campaign=a&utm_content=carousel&utm_term=keyword",
      source: "facebook",
      medium: "social",
      campaign: "fresh",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).not.toContain("utm_content=");
    expect(result.url).not.toContain("utm_term=");
  });
});
