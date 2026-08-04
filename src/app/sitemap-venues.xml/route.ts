export const dynamic = "force-dynamic";
import { getSitemapTypeLastMod } from "@/lib/sitemap-lastmod";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  conditionalXmlResponse,
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

export async function GET(request: Request): Promise<Response> {
  try {
    // OPE-333 — emit ETag + Last-Modified and honour a conditional GET, so an
    // unchanged sitemap costs a crawler a 304 instead of a full re-download.
    return await conditionalXmlResponse({
      request,
      body: serializeUrlset(await buildVenueUrls()),
      lastModified: await getSitemapTypeLastMod("venues"),
    });
  } catch (error) {
    console.error("sitemap-venues: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
