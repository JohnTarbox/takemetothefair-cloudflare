/**
 * OPE-200 — harvest-fetch parsing helpers.
 *
 * Pure (no I/O) so they're unit-testable and can't live in the route file
 * (Next.js forbids non-handler exports from a route module). Used by
 * /api/internal/harvest-fetch to turn a fetched DMO/aggregator document into the
 * two things the discovery harvest needs: the list of `<loc>` URLs from a
 * sitemap / sitemapindex, and (via the shared html-parser) per-event JSON-LD.
 */

/**
 * Extract `<loc>` URLs from a sitemap or sitemapindex XML document. Works for
 * both a `<urlset>` (page URLs) and a `<sitemapindex>` (child-sitemap URLs) —
 * the caller decides whether to recurse. De-duplicated, http(s)-only, capped.
 *
 * Also tolerates a Browser-Rendering fallback, where Chrome wraps the raw XML in
 * an HTML viewer but still embeds the original `<loc>` nodes in the DOM.
 */
export function extractSitemapUrls(xml: string, cap = 5000): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s][\s\S]*?)\s*<\/loc>/gi)) {
    // Sitemaps XML-escape `&` in query strings; decode the common entities so
    // the returned URL is directly fetchable.
    const url = m[1].trim().replace(/&amp;/g, "&").replace(/&#38;/g, "&");
    if (/^https?:\/\//i.test(url)) {
      out.add(url);
      if (out.size >= cap) break;
    }
  }
  return Array.from(out);
}

/**
 * Heuristic: does this document look like a sitemap (vs a normal HTML page)?
 * Checks for the sitemap root elements or a `<loc>` node near the top.
 */
export function looksLikeSitemap(doc: string): boolean {
  const head = doc.slice(0, 4000).toLowerCase();
  return (
    head.includes("<urlset") ||
    head.includes("<sitemapindex") ||
    head.includes("sitemaps.org/schemas/sitemap") ||
    /<loc>/i.test(head)
  );
}
