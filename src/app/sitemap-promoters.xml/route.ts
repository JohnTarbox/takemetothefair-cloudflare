export const dynamic = "force-dynamic";
import { getSitemapTypeLastMod } from "@/lib/sitemap-lastmod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  conditionalXmlResponse,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

// All promoters are public — the table has no status column; `verified`
// is a trust badge, not a visibility filter.
async function buildPromoterUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();
  const rows = await db
    .select({ slug: promoters.slug, updatedAt: promoters.updatedAt })
    .from(promoters);
  return rows.map((p) => ({
    url: `${SITEMAP_BASE_URL}/promoters/${p.slug}`,
    lastModified: safeLastMod(p.updatedAt),
    changeFrequency: "monthly",
    priority: 0.5,
  }));
}

export async function GET(request: Request): Promise<Response> {
  try {
    // OPE-333 — emit ETag + Last-Modified and honour a conditional GET, so an
    // unchanged sitemap costs a crawler a 304 instead of a full re-download.
    return await conditionalXmlResponse({
      request,
      body: serializeUrlset(await buildPromoterUrls()),
      lastModified: await getSitemapTypeLastMod("promoters"),
    });
  } catch (error) {
    console.error("sitemap-promoters: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
