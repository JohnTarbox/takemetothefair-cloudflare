/**
 * OPE-200 — sitemap <loc> extraction + sitemap detection.
 */
import { describe, it, expect } from "vitest";
import { extractSitemapUrls, looksLikeSitemap } from "../parse";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://visitrhodeisland.com/event/summer-fair/</loc></url>
  <url><loc>https://visitrhodeisland.com/event/fall-fest/?id=1&amp;src=x</loc></url>
  <url><loc>https://visitrhodeisland.com/event/summer-fair/</loc></url>
</urlset>`;

describe("extractSitemapUrls (OPE-200)", () => {
  it("pulls http(s) <loc> URLs, dedupes, and decodes &amp;", () => {
    const urls = extractSitemapUrls(SITEMAP);
    expect(urls).toEqual([
      "https://visitrhodeisland.com/event/summer-fair/",
      "https://visitrhodeisland.com/event/fall-fest/?id=1&src=x",
    ]);
  });

  it("handles a sitemapindex (child-sitemap locs)", () => {
    const idx = `<sitemapindex><sitemap><loc>https://x.com/sitemap-events.xml</loc></sitemap></sitemapindex>`;
    expect(extractSitemapUrls(idx)).toEqual(["https://x.com/sitemap-events.xml"]);
  });

  it("skips non-http locs and respects the cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => `<loc>https://x.com/${i}</loc>`).join("");
    expect(extractSitemapUrls(`<loc>ftp://nope</loc>${many}`, 5)).toHaveLength(5);
  });

  it("returns [] for a doc with no locs", () => {
    expect(extractSitemapUrls("<html><body>no sitemap here</body></html>")).toEqual([]);
  });
});

describe("looksLikeSitemap (OPE-200)", () => {
  it("detects urlset / sitemapindex / loc", () => {
    expect(looksLikeSitemap(SITEMAP)).toBe(true);
    expect(looksLikeSitemap("<sitemapindex>...")).toBe(true);
    expect(looksLikeSitemap("<loc>https://x.com/a</loc>")).toBe(true);
  });
  it("returns false for a normal HTML page", () => {
    expect(looksLikeSitemap("<!doctype html><html><head><title>Event</title></head></html>")).toBe(
      false
    );
  });
});
