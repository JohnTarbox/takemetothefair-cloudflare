import {
  SITEMAP_BASE_URL,
  serializeSitemapIndex,
  sitemapXmlHeaders,
  type SitemapIndexEntry,
} from "@/lib/sitemap-xml";

export const runtime = "edge";

// Sitemap index. References the six per-content-type child sitemaps. The
// index itself is purely structural — no D1, no possibility of error
// beyond a build-time bug, so the response is cheap to serve and safe to
// cache for a longer window. When adding a new content-type, mirror the
// new child URL here.
const CHILD_SITEMAPS = [
  "sitemap-static.xml",
  "sitemap-events.xml",
  "sitemap-venues.xml",
  "sitemap-vendors.xml",
  "sitemap-promoters.xml",
  "sitemap-blog.xml",
] as const;

export async function GET(): Promise<Response> {
  const now = new Date();
  const entries: SitemapIndexEntry[] = CHILD_SITEMAPS.map((child) => ({
    loc: `${SITEMAP_BASE_URL}/${child}`,
    // The index lastmod is a hint about when this index was generated;
    // crawlers use the children's lastmod entries for per-URL freshness.
    lastmod: now,
  }));
  return new Response(serializeSitemapIndex(entries), {
    headers: sitemapXmlHeaders(3600),
  });
}
