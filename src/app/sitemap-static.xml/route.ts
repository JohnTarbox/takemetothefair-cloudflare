import {
  SITEMAP_BASE_URL,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

export const runtime = "edge";

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
    {
      url: `${SITEMAP_BASE_URL}/promoters`,
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
  // Static URLs can cache aggressively — they only change when we deploy.
  return new Response(serializeUrlset(buildStaticUrls()), {
    headers: sitemapXmlHeaders(21600), // 6 hours
  });
}
