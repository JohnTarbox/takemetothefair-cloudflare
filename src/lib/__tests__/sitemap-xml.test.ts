import { describe, it, expect } from "vitest";
import { safeLastMod, serializeSitemapIndex, serializeUrlset, xmlEscape } from "@/lib/sitemap-xml";

describe("xmlEscape", () => {
  it("escapes the five XML predefined entities", () => {
    expect(xmlEscape("a & b")).toBe("a &amp; b");
    expect(xmlEscape("<tag>")).toBe("&lt;tag&gt;");
    expect(xmlEscape('"q"')).toBe("&quot;q&quot;");
    expect(xmlEscape("'q'")).toBe("&apos;q&apos;");
  });

  it("ampersand escapes first (no double-escape of &lt; etc.)", () => {
    // If `&` were escaped after `<`, we'd see `&amp;lt;`.
    expect(xmlEscape("&lt;")).toBe("&amp;lt;");
  });

  it("passes through plain text unchanged", () => {
    expect(xmlEscape("plain-slug-123")).toBe("plain-slug-123");
    expect(xmlEscape("https://example.com/path")).toBe("https://example.com/path");
  });
});

describe("safeLastMod", () => {
  it("returns the date when valid", () => {
    const d = new Date("2026-05-21T12:00:00Z");
    expect(safeLastMod(d).toISOString()).toBe("2026-05-21T12:00:00.000Z");
  });

  it("returns now when value is null or undefined", () => {
    const before = Date.now();
    expect(safeLastMod(null).getTime()).toBeGreaterThanOrEqual(before);
    expect(safeLastMod(undefined).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("returns now when Date is Invalid (the SQLite-text-in-timestamp case)", () => {
    // Drizzle returns `new Date(NaN)` for a non-numeric cell in a
    // timestamp column — guard prevents toISOString() from throwing.
    const invalid = new Date(NaN);
    const result = safeLastMod(invalid);
    expect(isNaN(result.getTime())).toBe(false);
  });

  it("coerces a numeric epoch (ms) into a Date", () => {
    const ms = Date.UTC(2026, 4, 21, 12, 0, 0); // 2026-05-21T12:00:00Z
    expect(safeLastMod(ms).toISOString()).toBe("2026-05-21T12:00:00.000Z");
  });
});

describe("serializeUrlset", () => {
  it("emits a well-formed empty urlset", () => {
    const xml = serializeUrlset([]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("</urlset>");
  });

  it("emits a single URL entry with all fields", () => {
    const xml = serializeUrlset([
      {
        url: "https://example.com/foo",
        lastModified: new Date("2026-05-21T12:00:00Z"),
        changeFrequency: "weekly",
        priority: 0.7,
      },
    ]);
    expect(xml).toContain("<loc>https://example.com/foo</loc>");
    expect(xml).toContain("<lastmod>2026-05-21T12:00:00.000Z</lastmod>");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.7</priority>");
  });

  it("omits optional fields when not provided", () => {
    const xml = serializeUrlset([{ url: "https://example.com/foo" }]);
    expect(xml).toContain("<loc>https://example.com/foo</loc>");
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("XML-escapes ampersands in URLs (the real-world failure mode)", () => {
    const xml = serializeUrlset([{ url: "https://example.com/foo?a=1&b=2" }]);
    expect(xml).toContain("<loc>https://example.com/foo?a=1&amp;b=2</loc>");
    expect(xml).not.toContain("&b=2"); // unescaped ampersand would break XML
  });

  it("clamps priority to [0.0, 1.0]", () => {
    const xml = serializeUrlset([
      { url: "https://example.com/a", priority: 2 },
      { url: "https://example.com/b", priority: -1 },
    ]);
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("<priority>0.0</priority>");
  });

  it("preserves URL order in the output", () => {
    const xml = serializeUrlset([
      { url: "https://example.com/a" },
      { url: "https://example.com/b" },
      { url: "https://example.com/c" },
    ]);
    expect(xml.indexOf("/a")).toBeLessThan(xml.indexOf("/b"));
    expect(xml.indexOf("/b")).toBeLessThan(xml.indexOf("/c"));
  });
});

describe("serializeSitemapIndex", () => {
  it("emits a well-formed sitemapindex with one entry", () => {
    const xml = serializeSitemapIndex([
      {
        loc: "https://example.com/sitemap-events.xml",
        lastmod: new Date("2026-05-21T12:00:00Z"),
      },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<sitemap>");
    expect(xml).toContain("<loc>https://example.com/sitemap-events.xml</loc>");
    expect(xml).toContain("<lastmod>2026-05-21T12:00:00.000Z</lastmod>");
    expect(xml).toContain("</sitemapindex>");
  });

  it("omits lastmod when not provided", () => {
    const xml = serializeSitemapIndex([{ loc: "https://example.com/sitemap-static.xml" }]);
    expect(xml).toContain("<loc>https://example.com/sitemap-static.xml</loc>");
    expect(xml).not.toContain("<lastmod>");
  });

  it("emits multiple sitemap entries in order", () => {
    const xml = serializeSitemapIndex([
      { loc: "https://example.com/sitemap-events.xml" },
      { loc: "https://example.com/sitemap-venues.xml" },
      { loc: "https://example.com/sitemap-vendors.xml" },
    ]);
    const sitemapCount = (xml.match(/<sitemap>/g) ?? []).length;
    expect(sitemapCount).toBe(3);
    expect(xml.indexOf("events")).toBeLessThan(xml.indexOf("venues"));
    expect(xml.indexOf("venues")).toBeLessThan(xml.indexOf("vendors"));
  });
});
