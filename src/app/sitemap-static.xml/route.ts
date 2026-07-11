export const dynamic = "force-dynamic";
import {
  SITEMAP_BASE_URL,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { desc, isNotNull } from "drizzle-orm";

const NOW = () => new Date();

// Static, hand-curated pages: site root, top-level listing pages, state
// landing pages, category hubs, top-of-funnel marketing pages, and legal.
// Anything that isn't generated from D1 lives here. When you add a new
// static route to the app, mirror it here.
function buildStaticUrls(): SitemapUrl[] {
  return [
    { url: SITEMAP_BASE_URL, lastModified: NOW(), changeFrequency: "daily", priority: 1 },
    {
      url: `${SITEMAP_BASE_URL}/events`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/past`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/all`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/maine`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/vermont`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/new-hampshire`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/massachusetts`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/connecticut`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/rhode-island`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/fairs`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/festivals`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/craft-shows`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/craft-fairs`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/markets`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/events/farmers-markets`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/venues`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITEMAP_BASE_URL}/vendors`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // OPE-40 — crawlable browse directories (A–Z + by state). Each index page
    // links every letter + state page, which link every detail page, so these
    // two URLs seed the shallow reachability tree for crawlers.
    {
      url: `${SITEMAP_BASE_URL}/vendors/browse`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITEMAP_BASE_URL}/venues/browse`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITEMAP_BASE_URL}/promoters`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      // OPE-122 — public performers index.
      url: `${SITEMAP_BASE_URL}/performers`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITEMAP_BASE_URL}/blog`,
      lastModified: NOW(),
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      // OPE-170 — public newsletter archive.
      url: `${SITEMAP_BASE_URL}/newsletter`,
      lastModified: NOW(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${SITEMAP_BASE_URL}/about`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITEMAP_BASE_URL}/contact`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITEMAP_BASE_URL}/faq`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITEMAP_BASE_URL}/search-visibility`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${SITEMAP_BASE_URL}/for-promoters`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITEMAP_BASE_URL}/for-vendors`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITEMAP_BASE_URL}/privacy`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITEMAP_BASE_URL}/terms`,
      lastModified: NOW(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}

export async function GET(): Promise<Response> {
  const urls = buildStaticUrls();
  // OPE-170 — append each SENT newsletter issue (sent_at not null; test-only
  // records stay out of the index). Best-effort: the static URLs still serve if
  // the query fails.
  try {
    const db = getCloudflareDb();
    const issues = await db
      .select({ slug: newsletterIssues.slug, sentAt: newsletterIssues.sentAt })
      .from(newsletterIssues)
      .where(isNotNull(newsletterIssues.sentAt))
      .orderBy(desc(newsletterIssues.sentAt))
      .limit(500);
    for (const iss of issues) {
      urls.push({
        url: `${SITEMAP_BASE_URL}/newsletter/${iss.slug}`,
        lastModified: iss.sentAt ?? NOW(),
        changeFrequency: "yearly",
        priority: 0.5,
      });
    }
  } catch {
    /* best-effort — static URLs still serve */
  }
  return new Response(serializeUrlset(urls), {
    headers: sitemapXmlHeaders(21600), // 6 hours
  });
}
