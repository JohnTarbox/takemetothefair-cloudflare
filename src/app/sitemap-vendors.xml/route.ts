export const dynamic = "force-dynamic";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
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
// independently, so they can't share work. At ~1.3K vendors this is fine;
// if it gets expensive, cache an `eventVenueGeoCount` column.
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

export async function GET(): Promise<Response> {
  try {
    return new Response(serializeUrlset(await buildVendorUrls()), {
      headers: sitemapXmlHeaders(3600),
    });
  } catch (error) {
    console.error("sitemap-vendors: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
