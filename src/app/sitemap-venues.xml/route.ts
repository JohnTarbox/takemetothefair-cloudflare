export const dynamic = "force-dynamic";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

async function buildVenueUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();
  const rows = await db
    .select({ slug: venues.slug, updatedAt: venues.updatedAt })
    .from(venues)
    .where(eq(venues.status, "ACTIVE"));
  return rows.map((v) => ({
    url: `${SITEMAP_BASE_URL}/venues/${v.slug}`,
    lastModified: safeLastMod(v.updatedAt),
    changeFrequency: "monthly",
    priority: 0.6,
  }));
}

export async function GET(): Promise<Response> {
  try {
    return new Response(serializeUrlset(await buildVenueUrls()), {
      headers: sitemapXmlHeaders(3600),
    });
  } catch (error) {
    console.error("sitemap-venues: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
