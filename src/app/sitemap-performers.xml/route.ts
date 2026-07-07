export const dynamic = "force-dynamic";
/**
 * OPE-115 §6.4 — /performers/* child sitemap. Includes non-deleted performers
 * that have at least one CONFIRMED appearance (so the page has public content —
 * we don't sitemap thin shells with no schedule). Linked from the sitemap index.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { performers, eventPerformers } from "@/lib/db/schema";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

async function buildPerformerUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();
  const rows = await db
    .selectDistinct({ slug: performers.slug, updatedAt: performers.updatedAt })
    .from(performers)
    .innerJoin(
      eventPerformers,
      and(eq(eventPerformers.performerId, performers.id), eq(eventPerformers.status, "CONFIRMED"))
    )
    .where(isNull(performers.deletedAt));

  return rows.map(({ slug, updatedAt }) => ({
    url: `${SITEMAP_BASE_URL}/performers/${slug}`,
    lastModified: safeLastMod(updatedAt ? updatedAt.getTime() : null),
    changeFrequency: "weekly",
    priority: 0.5,
  }));
}

export async function GET(): Promise<Response> {
  try {
    return new Response(serializeUrlset(await buildPerformerUrls()), {
      headers: sitemapXmlHeaders(3600),
    });
  } catch (error) {
    console.error("sitemap-performers: D1 query failed", error);
    return new Response(serializeUrlset([]), { headers: sitemapXmlHeaders(60) });
  }
}
