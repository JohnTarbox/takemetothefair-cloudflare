export const dynamic = "force-dynamic";
import { getSitemapTypeLastMod } from "@/lib/sitemap-lastmod";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  conditionalXmlResponse,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";
import {
  getSitemapPriorityTier,
  sitemapChangeFreqFor,
  sitemapPriorityFor,
} from "@/lib/vendor-tier";
import { getIndexableVendorRows } from "@/lib/sitemap/indexable-vendors";

// The SEO gate is applied as raw SQL so we can reference event_vendors →
// events → venues for the geographic-anchor fallback, which Drizzle's
// query builder can't express cleanly. Within the indexable set,
// getSitemapPriorityTier() classifies HIGH/MEDIUM/LOW for <priority> and
// <changefreq>. Google largely ignores those signals; Bing still uses
// them and currently delivers >4× MMATF's Google organic traffic, so the
// gradient is meaningful.
//
// The EXISTS subquery in the WHERE and the correlated COUNT in the SELECT
// both walk event_vendors → events → venues; SQLite plans these
// independently, so they can't share work. OPE-1395 (2026-10-16): this note
// once said "~1.3K vendors"; there are now ~11.6K and a render reads ~32K
// rows (prod EXPLAIN/rows_read). Still tolerable for a crawler-only route, but
// if it grows, cache an `eventVenueGeoCount` column.
//
// Why it stays force-dynamic (not `revalidate`): the handler reads the request
// for its conditional GET (If-None-Match / If-Modified-Since → 304), and on a
// D1 failure it returns an EMPTY urlset — a cached copy of that would tell
// crawlers every vendor URL was gone for the whole revalidate window. Every
// other sitemap route is force-dynamic for the same reasons.
async function buildVendorUrls(): Promise<SitemapUrl[]> {
  // A10/A11 — the indexable-vendor gate now lives in the shared helper so the
  // GSC sweep inspects the SAME vendor set this sitemap publishes.
  const indexable = await getIndexableVendorRows(getCloudflareDb());
  return indexable.map(({ slug, updatedAt, fields, tier }) => {
    const priorityTier = getSitemapPriorityTier(fields, tier);
    return {
      url: `${SITEMAP_BASE_URL}/vendors/${slug}`,
      // updated_at is stored as seconds-epoch in this column; convert to ms.
      lastModified: safeLastMod(updatedAt ? updatedAt * 1000 : null),
      changeFrequency: sitemapChangeFreqFor(priorityTier),
      priority: sitemapPriorityFor(priorityTier),
    };
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    // OPE-333 — emit ETag + Last-Modified and honour a conditional GET, so an
    // unchanged sitemap costs a crawler a 304 instead of a full re-download.
    return await conditionalXmlResponse({
      request,
      body: serializeUrlset(await buildVendorUrls()),
      lastModified: await getSitemapTypeLastMod("vendors"),
    });
  } catch (error) {
    console.error("sitemap-vendors: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
