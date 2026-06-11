export const dynamic = "force-dynamic";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
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

export async function GET(): Promise<Response> {
  try {
    return new Response(serializeUrlset(await buildPromoterUrls()), {
      headers: sitemapXmlHeaders(3600),
    });
  } catch (error) {
    console.error("sitemap-promoters: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
